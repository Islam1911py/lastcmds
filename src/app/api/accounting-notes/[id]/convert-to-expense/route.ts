import { NextRequest, NextResponse } from "next/server"
import { getServerSession } from "next-auth"
import { authOptions } from "@/lib/auth"
import { db as prisma } from "@/lib/db"

// POST /api/accounting-notes/[id]/convert-to-expense
export async function POST(
  req: NextRequest,
  { params }: { params: { id: string } }
) {
  try {
    const session = await getServerSession(authOptions)

    if (!session) {
      return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
    }

    // Only Accountant and Admin can convert
    if (session.user.role !== "ACCOUNTANT" && session.user.role !== "ADMIN") {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 })
    }

    const { id } = params
    const body = await req.json()
    const { pmAdvanceId } = body

    // Get the accounting note
    const note = await prisma.accountingNote.findUnique({
      where: { id },
      include: {
        unit: {
          include: { project: true }
        },
        project: true
      }
    })

    if (!note) {
      return NextResponse.json(
        { error: "Accounting note not found" },
        { status: 404 }
      )
    }

    if (note.status !== "PENDING") {
      return NextResponse.json(
        { error: "Only pending notes can be converted" },
        { status: 400 }
      )
    }

    const resolvedSourceType = note.sourceType
    const resolvedPmAdvanceId = pmAdvanceId ?? note.pmAdvanceId

    if (resolvedSourceType === "PM_ADVANCE" && !resolvedPmAdvanceId) {
      return NextResponse.json(
        { error: "PM Advance ID is required for PM advance notes" },
        { status: 400 }
      )
    }

    // Verify PM Advance exists and has sufficient balance if needed
    let pmAdvance = null
    if (resolvedSourceType === "PM_ADVANCE" && resolvedPmAdvanceId) {
      pmAdvance = await prisma.pMAdvance.findUnique({
        where: { id: resolvedPmAdvanceId }
      })

      if (!pmAdvance) {
        return NextResponse.json(
          { error: "PM Advance not found" },
          { status: 404 }
        )
      }

      if (pmAdvance.remainingAmount < note.amount) {
        return NextResponse.json(
          { error: "Insufficient PM Advance balance" },
          { status: 400 }
        )
      }
    }

    // Get or create owner association for this unit
    let ownerAssociation = await prisma.ownerAssociation.findFirst({
      where: { unitId: note.unitId }
    })

    if (!ownerAssociation) {
      ownerAssociation = await prisma.ownerAssociation.create({
        data: {
          name: `Owner - ${note.unit.name}`,
          unitId: note.unitId,
          phone: "",
          email: ""
        }
      })
    }

    // Create a CLAIM invoice for this note
    const invoiceNumber = `CLM-${Date.now()}-${note.unit.code}`
    const invoice = await prisma.invoice.create({
      data: {
        invoiceNumber,
        type: "CLAIM",
        unitId: note.unitId,
        ownerAssociationId: ownerAssociation.id,
        amount: note.amount,
        remainingBalance: note.amount
      }
    })

    // Create Operational Expense from the note
    const expense = await prisma.operationalExpense.create({
      data: {
        unitId: note.unitId,
        description: note.description,
        amount: note.amount,
        sourceType: resolvedSourceType,
        recordedByUserId: session.user.id,
        pmAdvanceId: resolvedSourceType === "PM_ADVANCE" ? resolvedPmAdvanceId : null,
        claimInvoiceId: invoice.id,
        convertedFromNoteId: note.id
      }
    })

    // Deduct from PM Advance if applicable
    if (resolvedSourceType === "PM_ADVANCE" && resolvedPmAdvanceId && pmAdvance) {
      await prisma.pMAdvance.update({
        where: { id: resolvedPmAdvanceId },
        data: {
          remainingAmount: {
            decrement: note.amount
          }
        }
      })
    }

    // Update the accounting note status
    await prisma.accountingNote.update({
      where: { id },
      data: {
        status: "CONVERTED",
        convertedAt: new Date(),
        convertedToExpenseId: expense.id,
        pmAdvanceId: resolvedSourceType === "PM_ADVANCE" ? resolvedPmAdvanceId : null,
        sourceType: resolvedSourceType
      }
    })

    return NextResponse.json({
      note: { ...note, status: "CONVERTED", convertedAt: new Date(), pmAdvanceId: resolvedPmAdvanceId },
      expense,
      invoice
    })
  } catch (error) {
    console.error("Error converting note to expense:", error)
    return NextResponse.json(
      { error: "Failed to convert note to expense" },
      { status: 500 }
    )
  }
}
