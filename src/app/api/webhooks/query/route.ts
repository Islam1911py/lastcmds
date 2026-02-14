import { NextRequest, NextResponse } from "next/server"
import { db } from "@/lib/db"
import { verifyN8nApiKey, logWebhookEvent } from "@/lib/n8n-auth"
import { buildPhoneVariants } from "@/lib/phone"

// GET /api/webhooks/query - للاستعلامات بناء على الـ role
export async function GET(req: NextRequest) {
  const ipAddress = req.headers.get("x-forwarded-for") || "unknown"

  try {
    // Verify API key
    const auth = await verifyN8nApiKey(req)
    if (!auth.valid || !auth.context) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401 }
      )
    }

    const { searchParams } = new URL(req.url)
    const queryType = searchParams.get("type") || "DEFAULT"
    const senderPhone = searchParams.get("senderPhone")
    const projectNameParamRaw = searchParams.get("projectName")
    const projectNameParam = projectNameParamRaw ? projectNameParamRaw.trim() : null

    let resolvedProjectId: string | null = null
    let requestingUser: null | {
      id: string
      role: string
      canViewAllProjects: boolean
      assignedProjects: {
        projectId: string
        project: { id: string; name: string } | null
      }[]
    } = null

    if (senderPhone && auth.context.role !== "RESIDENT") {
      const phoneVariants = buildPhoneVariants(senderPhone)
      requestingUser = await db.user.findFirst({
        where: {
          role: auth.context.role,
          whatsappPhone: { in: phoneVariants }
        },
        select: {
          id: true,
          role: true,
          canViewAllProjects: true,
          assignedProjects: {
            select: {
              projectId: true,
              project: {
                select: {
                  id: true,
                  name: true
                }
              }
            }
          }
        }
      })

      if (!requestingUser) {
        return NextResponse.json(
          { error: "Unauthorized sender phone" },
          { status: 403 }
        )
      }

      if (auth.context.role === "PROJECT_MANAGER") {
        const assignedProjects = requestingUser.assignedProjects.map((assignment) => ({
          id: assignment.project?.id ?? assignment.projectId,
          name: assignment.project?.name ?? assignment.projectId
        }))

        const projectIdParamRaw = searchParams.get("projectId")
        const projectIdParam = projectIdParamRaw ? projectIdParamRaw.trim() : null
        resolvedProjectId = projectIdParam || auth.context.projectId || null

        if (!resolvedProjectId && projectNameParam) {
          const normalizedName = projectNameParam.toLowerCase()
          const directAssignment = requestingUser.assignedProjects.find((assignment) => {
            const assignmentName = assignment.project?.name ?? ""
            return assignmentName.trim().toLowerCase() === normalizedName
          })

          if (directAssignment) {
            resolvedProjectId = directAssignment.projectId
          } else if (requestingUser.canViewAllProjects) {
            const projectMatch = await db.project.findFirst({
              where: { name: projectNameParam },
              select: { id: true, name: true }
            })

            if (projectMatch) {
              resolvedProjectId = projectMatch.id
            } else {
              const fallbackMatches = await db.$queryRaw<{ id: string }[]>`
                SELECT "id" FROM "Project"
                WHERE LOWER("name") = LOWER(${projectNameParam})
                LIMIT 1
              `

              if (fallbackMatches.length > 0) {
                resolvedProjectId = fallbackMatches[0].id
              }
            }
          }

          if (!resolvedProjectId) {
            return NextResponse.json(
              {
                error: "Project not found for provided name",
                requestedName: projectNameParam,
                canViewAllProjects: requestingUser.canViewAllProjects,
                assignedProjects
              },
              { status: 404 }
            )
          }
        }

        if (!resolvedProjectId) {
          return NextResponse.json(
            {
              success: true,
              role: "PROJECT_MANAGER",
              requiresProjectId: !requestingUser.canViewAllProjects,
              canViewAllProjects: requestingUser.canViewAllProjects,
              assignedProjects
            },
            { status: 200 }
          )
        }

        resolvedProjectId = resolvedProjectId.trim()

        if (
          !requestingUser.canViewAllProjects &&
          !requestingUser.assignedProjects.some(
            (assignment) => assignment.projectId === resolvedProjectId
          )
        ) {
          return NextResponse.json(
            { error: "Project Manager is not assigned to this project" },
            { status: 403 }
          )
        }
      }
    }

    let data: any = {}

    // ========================================
    // ACCOUNTANT QUERIES
    // ========================================
    if (auth.context.role === "ACCOUNTANT") {
      if (queryType === "ACCOUNTING_DATA" || queryType === "DEFAULT") {
        // Get all invoices, payments, and accounting data
        const invoices = await db.invoice.findMany({
          include: {
            payments: true,
            ownerAssociation: true,
            unit: true
          }
        })

        const accountingNotes = await db.accountingNote.findMany({
          where: { status: "PENDING" },
          include: {
            unit: true,
            createdByUser: true,
            project: true
          }
        })

        const totalInvoices = invoices.length
        const totalPaid = invoices.reduce(
          (sum, inv) => sum + inv.payments.reduce((s, p) => s + p.amount, 0),
          0
        )
        const totalRemaining = invoices.reduce(
          (sum, inv) => sum + (inv.amount - inv.payments.reduce((s, p) => s + p.amount, 0)),
          0
        )

        data = {
          role: "ACCOUNTANT",
          statistics: {
            totalInvoices,
            totalPaid: Math.round(totalPaid * 100) / 100,
            totalRemaining: Math.round(totalRemaining * 100) / 100
          },
          invoices: invoices.map((inv) => ({
            id: inv.id,
            invoiceNumber: inv.invoiceNumber,
            type: inv.type,
            amount: inv.amount,
            unit: inv.unit.code,
            ownerAssociation: inv.ownerAssociation.name,
            totalPaid: inv.payments.reduce((s, p) => s + p.amount, 0),
            remainingBalance:
              inv.amount -
              inv.payments.reduce((s, p) => s + p.amount, 0),
            paymentCount: inv.payments.length,
            createdAt: inv.issuedAt
          })),
          pendingAccountingNotes: accountingNotes.map((note) => ({
            id: note.id,
            description: note.description,
            amount: note.amount,
            unit: note.unit.code,
            project: note.project.name,
            createdBy: note.createdByUser.name,
            createdAt: note.createdAt
          }))
        }
      }

      // ========================================
      // ADMIN QUERIES
      // ========================================
    } else if (auth.context.role === "ADMIN") {
      if (queryType === "ALL_DATA" || queryType === "DEFAULT") {
        const [
          projects,
          operationalUnits,
          residents,
          tickets,
          invoices,
          technicians,
          staff
        ] = await Promise.all([
          db.project.findMany({
            include: { projectType: true }
          }),
          db.operationalUnit.findMany(),
          db.resident.findMany(),
          db.ticket.findMany({ include: { resident: true, unit: true } }),
          db.invoice.findMany({ include: { payments: true } }),
          db.technician.findMany({ include: { specialty: true } }),
          db.staff.findMany()
        ])

        data = {
          role: "ADMIN",
          summary: {
            totalProjects: projects.length,
            totalUnits: operationalUnits.length,
            totalResidents: residents.length,
            totalTickets: tickets.length,
            openTickets: tickets.filter((t) => t.status !== "DONE").length,
            totalTechnicians: technicians.length,
            totalStaff: staff.length
          },
          projects: projects.map((p) => ({
            id: p.id,
            name: p.name,
            type: p.projectType?.name ?? null,
            isActive: p.isActive
          })),
          units: operationalUnits.map((u) => ({
            id: u.id,
            code: u.code,
            name: u.name,
            projectId: u.projectId
          })),
          residents: residents.map((r) => ({
            id: r.id,
            name: r.name,
            email: r.email,
            phone: r.phone,
            status: r.status
          })),
          technicians: technicians.map((t) => ({
            id: t.id,
            name: t.name,
            phone: t.phone,
            specialty: t.specialty?.name ?? null
          }))
        }
      }

      // ========================================
      // PROJECT MANAGER QUERIES
      // ========================================
    } else if (auth.context.role === "PROJECT_MANAGER") {
      const projectId = (
        resolvedProjectId ??
        searchParams.get("projectId") ??
        auth.context.projectId ??
        ""
      ).trim()

      if (!projectId) {
        return NextResponse.json(
          { error: "Project ID is required for PROJECT_MANAGER" },
          { status: 400 }
        )
      }

      if (queryType === "PROJECT_DATA" || queryType === "DEFAULT") {
        const [project, units, residents, tickets, technicians, staff] =
          await Promise.all([
            db.project.findUnique({ where: { id: projectId }, include: { projectType: true } }),
            db.operationalUnit.findMany({ where: { projectId } }),
            db.resident.findMany({
              where: {
                unit: { projectId }
              }
            }),
            db.ticket.findMany({
              where: {
                unit: { projectId }
              },
              include: { resident: true, unit: true }
            }),
            db.technician.findMany({ include: { specialty: true } }),
            db.staff.findMany({
              where: {
                unit: { projectId }
              }
            })
          ])

        data = {
          role: "PROJECT_MANAGER",
          project: {
            id: project?.id,
            name: project?.name,
            type: project?.projectType?.name ?? null
          },
          summary: {
            totalUnits: units.length,
            totalResidents: residents.length,
            openTickets: tickets.filter((t) => t.status !== "DONE").length,
            totalTickets: tickets.length,
            totalTechnicians: technicians.length,
            totalStaff: staff.length
          },
          units: units.map((u) => ({
            id: u.id,
            code: u.code,
            name: u.name
          })),
          residents: residents.map((r) => ({
            id: r.id,
            name: r.name,
            email: r.email,
            phone: r.phone,
            unit: r.unitId
          })),
          openTickets: tickets
            .filter((t) => t.status !== "DONE")
            .map((t) => ({
              id: t.id,
              title: t.title,
              unit: t.unit.code,
              resident: t.resident?.name ?? null,
              status: t.status,
              priority: t.priority
            })),
          technicians: technicians.map((t) => ({
            id: t.id,
            name: t.name,
            phone: t.phone,
            specialty: t.specialty?.name ?? null
          })),
          staff: staff.map((s) => ({
            id: s.id,
            name: s.name,
            role: s.role,
            phone: s.phone
          }))
        }
      }

      if (queryType === "TODAY_TICKETS") {
        const startOfDay = new Date()
        startOfDay.setHours(0, 0, 0, 0)
        const endOfDay = new Date()
        endOfDay.setHours(23, 59, 59, 999)

        const tickets = await db.ticket.findMany({
          where: {
            unit: { projectId },
            createdAt: {
              gte: startOfDay,
              lte: endOfDay
            }
          },
          include: { resident: true, unit: true }
        })

        data = {
          role: "PROJECT_MANAGER",
          projectId,
          date: startOfDay.toISOString().substring(0, 10),
          count: tickets.length,
          tickets: tickets.map((t) => ({
            id: t.id,
            title: t.title,
            description: t.description,
            priority: t.priority,
            status: t.status,
            resident: t.resident?.name ?? null,
            residentPhone: t.resident?.phone ?? null,
            unit: t.unit.code,
            unitName: t.unit.name,
            createdAt: t.createdAt
          }))
        }
      }

      // ========================================
      // RESIDENT QUERIES (Limited)
      // ========================================
    } else if (auth.context.role === "RESIDENT") {
      // Residents can only query their own tickets
      if (queryType === "MY_TICKETS" || queryType === "DEFAULT") {
        // Get resident from email/phone (would need to implement this properly)
        data = {
          role: "RESIDENT",
          message:
            "Residents cannot query via webhooks. Please use the dashboard."
        }
      }
    }

    const response = {
      success: true,
      ...data
    }

    await logWebhookEvent(
      auth.context.keyId,
      "QUERY_EXECUTED",
      "/api/webhooks/query",
      "GET",
      200,
      { type: queryType },
      response,
      undefined,
      ipAddress
    )

    return NextResponse.json(response)
  } catch (error) {
    console.error("Error executing query:", error)

    const auth = await verifyN8nApiKey(req)
    if (auth.context) {
      await logWebhookEvent(
        auth.context.keyId,
        "QUERY_EXECUTED",
        "/api/webhooks/query",
        "GET",
        500,
        undefined,
        { error: "Internal server error" },
        error instanceof Error ? error.message : "Unknown error",
        ipAddress
      )
    }

    return NextResponse.json(
      { error: "Failed to execute query" },
      { status: 500 }
    )
  }
}
