import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { db } from "@/lib/db"

// GET /api/accounting-notes/[id] - Get single accounting note
export async function GET(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const normalizedId = id?.toString().trim()
    const session = await getServerSession(authOptions)

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    if (!normalizedId) {
      return NextResponse.json({ error: "Invalid accounting note id" }, { status: 400 })
    }

    const role = session.user.role as string

    const note = await db.accountingNote.findUnique({
      where: { id: normalizedId },
      include: {
        unit: {
          include: {
            project: true
          }
        },
        project: true,
        createdByUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        convertedToExpense: {
          include: {
            recordedByUser: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          }
        },
        pmAdvance: {
          include: {
            staff: {
              select: { id: true, name: true }
            }
          }
        }
      }
    })

    if (!note) {
      return NextResponse.json({ error: "Accounting note not found" }, { status: 404 })
    }

    // Check if user has access to this note
    if (role === "PROJECT_MANAGER") {
      // PMs can only see notes from their assigned projects
      const assignments = await db.projectAssignment.findMany({
        where: { userId: session.user.id },
        select: { projectId: true }
      })
      const projectIds = assignments.map(a => a.projectId)
      
      if (!projectIds.includes(note.unit.projectId)) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 })
      }
    }

    return NextResponse.json(note)
  } catch (error) {
    console.error("Error fetching accounting note:", error)
    return NextResponse.json(
      { error: "Failed to fetch accounting note" },
      { status: 500 }
    )
  }
}

// PATCH /api/accounting-notes/[id] - Update accounting note (record it)
export async function PATCH(
  req: NextRequest,
  context: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await context.params
    const normalizedId = id?.toString().trim()
    const session = await getServerSession(authOptions)

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    if (!normalizedId) {
      return NextResponse.json({ error: "Invalid accounting note id" }, { status: 400 })
    }

    const role = session.user.role as string
    const userId = session.user.id

    // Check if note exists
    const existingNote = await db.accountingNote.findUnique({
      where: { id: normalizedId }
    })

    if (!existingNote) {
      return NextResponse.json({ error: "Accounting note not found" }, { status: 404 })
    }

    const body = await req.json()
    const { status, sourceType, pmAdvanceId } = body

    // Only Accountant and Admin can record accounting notes
    if (role !== "ACCOUNTANT" && role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    // Prepare update data
    const updateData: any = {}

    if (status === "CONVERTED") {
      // Get the unit with project info
      const unit = await db.operationalUnit.findUnique({
        where: { id: existingNote.unitId },
        include: { project: true }
      })

      if (!unit) {
        return NextResponse.json({ error: "Unit not found" }, { status: 404 })
      }

      // Find the OwnerAssociation for this unit
      let ownerAssociation = await db.ownerAssociation.findUnique({
        where: { unitId: existingNote.unitId }
      })

      if (!ownerAssociation) {
        ownerAssociation = await db.ownerAssociation.create({
          data: {
            name: `Owner - ${unit.name}`,
            unitId: existingNote.unitId,
            phone: "",
            email: ""
          }
        })
      }

      const resolvedSourceType = sourceType ?? existingNote.sourceType ?? "OFFICE_FUND"
      const resolvedPmAdvanceId = pmAdvanceId ?? existingNote.pmAdvanceId

      if (resolvedSourceType === "PM_ADVANCE" && !resolvedPmAdvanceId) {
        return NextResponse.json(
          { error: "PM advance is required when using PM_ADVANCE" },
          { status: 400 }
        )
      }

      if (resolvedSourceType === "PM_ADVANCE" && resolvedPmAdvanceId) {
        const advance = await db.pMAdvance.findUnique({ where: { id: resolvedPmAdvanceId } })

        if (!advance) {
          return NextResponse.json({ error: "PM Advance not found" }, { status: 404 })
        }

      }

      const invoiceNumber = `CLM-${Date.now()}-${unit.code}`
      const invoice = await db.invoice.create({
        data: {
          invoiceNumber,
          type: "CLAIM",
          unitId: existingNote.unitId,
          ownerAssociationId: ownerAssociation.id,
          amount: existingNote.amount,
          remainingBalance: existingNote.amount
        }
      })

      const expense = await db.operationalExpense.create({
        data: {
          unitId: existingNote.unitId,
          description: existingNote.description,
          amount: existingNote.amount,
          sourceType: resolvedSourceType,
          recordedByUserId: userId,
          pmAdvanceId: resolvedSourceType === "PM_ADVANCE" ? resolvedPmAdvanceId : null,
          claimInvoiceId: invoice.id
        }
      })

      if (resolvedSourceType === "PM_ADVANCE" && resolvedPmAdvanceId) {
        await db.pMAdvance.update({
          where: { id: resolvedPmAdvanceId },
          data: {
            remainingAmount: {
              decrement: existingNote.amount
            }
          }
        })
      }

      updateData.status = "CONVERTED"
      updateData.convertedAt = new Date()
      updateData.convertedToExpenseId = expense.id
      updateData.sourceType = resolvedSourceType
      updateData.pmAdvanceId = resolvedSourceType === "PM_ADVANCE" ? resolvedPmAdvanceId : null
    } else if (status === "REJECTED") {
      updateData.status = "REJECTED"
      updateData.convertedAt = new Date()
    } else {
      return NextResponse.json({ error: "Invalid status. Use CONVERTED or REJECTED" }, { status: 400 })
    }

    // Update accounting note
    await db.accountingNote.update({
      where: { id: normalizedId },
      data: updateData
    })

    if (updateData.convertedToExpenseId) {
      await db.operationalExpense.update({
        where: { id: updateData.convertedToExpenseId },
        data: { convertedFromNoteId: updateData.convertedToExpenseId }
      })
    }

    const refreshedNote = await db.accountingNote.findUnique({
      where: { id: normalizedId },
      include: {
        unit: {
          include: {
            project: true
          }
        },
        createdByUser: {
          select: {
            id: true,
            name: true,
            email: true
          }
        },
        convertedToExpense: {
          include: {
            recordedByUser: {
              select: {
                id: true,
                name: true,
                email: true
              }
            }
          }
        },
        pmAdvance: {
          include: {
            staff: {
              select: { id: true, name: true }
            }
          }
        }
      }
    })

    if (!refreshedNote) {
      return NextResponse.json({ error: "Accounting note not found" }, { status: 404 })
    }

    return NextResponse.json(refreshedNote)
  } catch (error) {
    console.error("Error updating accounting note:", error)
    return NextResponse.json(
      { error: "Failed to update accounting note", details: String(error) },
      { status: 500 }
    )
  }
}

// DELETE /api/accounting-notes/[id] - Delete accounting note (Admin only)
export async function DELETE(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  try {
    const { id } = await params
    const session = await getServerSession(authOptions)

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    const role = session.user.role as string

    // Only Admin can delete accounting notes
    if (role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    await db.accountingNote.delete({
      where: { id }
    })

    return NextResponse.json({ message: "Accounting note deleted successfully" })
  } catch (error) {
    console.error("Error deleting accounting note:", error)
    return NextResponse.json(
      { error: "Failed to delete accounting note" },
      { status: 500 }
    )
  }
}
