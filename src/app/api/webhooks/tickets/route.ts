import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { verifyN8nApiKey, logWebhookEvent } from "@/lib/n8n-auth"
import { notifyN8nEvent } from "@/lib/n8n-notify"

export async function POST(req: NextRequest) {
  const ipAddress = req.headers.get("x-forwarded-for") || "unknown"

  try {
    const body = await req.json()

    // Verify API key
    const auth = await verifyN8nApiKey(req)
    if (!auth.valid || !auth.context) {
      return NextResponse.json(
        { error: auth.error || "Unauthorized" },
        { status: 401 }
      )
    }

    // Only RESIDENT role can create tickets
    if (auth.context.role !== "RESIDENT") {
      await logWebhookEvent(
        auth.context.keyId,
        "TICKET_CREATED",
        "/api/webhooks/tickets",
        "POST",
        403,
        body,
        { error: "Insufficient permissions" },
        "Only residents can create tickets",
        ipAddress
      )

      return NextResponse.json(
        { error: "Only residents can create tickets" },
        { status: 403 }
      )
    }

    // Validate required fields
    const {
      residentName,
      residentEmail,
      residentPhone,
      unitCode,
      unitName,
      buildingNumber,
      projectName,
      title,
      description,
      priority
    } = body

    const trimmedResidentName = typeof residentName === "string" ? residentName.trim() : ""
    const trimmedTitle = typeof title === "string" ? title.trim() : ""
    const trimmedDescription = typeof description === "string" ? description.trim() : ""
    const trimmedProjectName = typeof projectName === "string" ? projectName.trim() : ""
    const trimmedUnitCode =
      typeof unitCode === "string" && unitCode.trim() !== "" ? unitCode.trim() : undefined
    const trimmedBuildingNumber =
      typeof buildingNumber === "string" && buildingNumber.trim() !== ""
        ? buildingNumber.trim()
        : undefined
    const trimmedUnitName =
      typeof unitName === "string" && unitName.trim() !== "" ? unitName.trim() : undefined
    const requestedUnitCode = trimmedUnitCode ?? trimmedBuildingNumber

    if (!trimmedResidentName || !trimmedTitle || !trimmedDescription) {
      await logWebhookEvent(
        auth.context.keyId,
        "TICKET_CREATED",
        "/api/webhooks/tickets",
        "POST",
        400,
        body,
        { error: "Missing required fields" },
        "Missing: residentName, title, or description",
        ipAddress
      )

      return NextResponse.json(
        {
          error: "Missing required fields: residentName, title, description"
        },
        { status: 400 }
      )
    }

    if (!requestedUnitCode && !trimmedUnitName) {
      await logWebhookEvent(
        auth.context.keyId,
        "TICKET_CREATED",
        "/api/webhooks/tickets",
        "POST",
        400,
        body,
        { error: "Missing unit information" },
        "Missing unit identifier (unitCode/buildingNumber or unitName)",
        ipAddress
      )

      return NextResponse.json(
        {
          error: "Missing unit details. Please provide building number or unit name."
        },
        { status: 400 }
      )
    }

    // Resolve project if provided
    let project: { id: string; name: string } | null = null
    if (trimmedProjectName) {
      project = await db.project.findFirst({
        where: { name: trimmedProjectName },
        select: { id: true, name: true }
      })

      if (!project) {
        const fallbackProject = await db.$queryRaw<{ id: string; name: string }[]>(
          Prisma.sql`SELECT "id", "name" FROM "Project" WHERE LOWER("name") = LOWER(${trimmedProjectName}) LIMIT 1`
        )

        if (fallbackProject.length > 0) {
          project = fallbackProject[0]
        }
      }

      if (!project) {
        return NextResponse.json(
          {
            error: "Project not found",
            requestedName: trimmedProjectName
          },
          { status: 404 }
        )
      }
    }

    // Resolve unit by code/name within optional project scope
    let unit: Awaited<ReturnType<typeof db.operationalUnit.findFirst>> | null = null

    if (requestedUnitCode) {
      unit = await db.operationalUnit.findFirst({
        where: {
          code: requestedUnitCode,
          ...(project ? { projectId: project.id } : {})
        },
        include: { project: true }
      })

      if (!unit && project) {
        const fallbackUnit = await db.$queryRaw<{ id: string }[]>(
          Prisma.sql`
            SELECT "id" FROM "OperationalUnit"
            WHERE LOWER("code") = LOWER(${requestedUnitCode})
              AND "projectId" = ${project.id}
            LIMIT 1
          `
        )

        if (fallbackUnit.length > 0) {
          unit = await db.operationalUnit.findUnique({
            where: { id: fallbackUnit[0].id },
            include: { project: true }
          })
        }
      }
    }

    if (!unit && trimmedUnitName) {
      unit = await db.operationalUnit.findFirst({
        where: {
          name: trimmedUnitName,
          ...(project ? { projectId: project.id } : {})
        },
        include: { project: true }
      })

      if (!unit && project) {
        const fallbackUnitByName = await db.$queryRaw<{ id: string }[]>(
          Prisma.sql`
            SELECT "id" FROM "OperationalUnit"
            WHERE LOWER("name") = LOWER(${trimmedUnitName})
              AND "projectId" = ${project.id}
            LIMIT 1
          `
        )

        if (fallbackUnitByName.length > 0) {
          unit = await db.operationalUnit.findUnique({
            where: { id: fallbackUnitByName[0].id },
            include: { project: true }
          })
        }
      }
    }

    if (!unit) {
      await logWebhookEvent(
        auth.context.keyId,
        "TICKET_CREATED",
        "/api/webhooks/tickets",
        "POST",
        404,
        body,
        { error: "Unit not found" },
        "Unable to resolve unit from provided details",
        ipAddress
      )

      return NextResponse.json(
        {
          error: "Unable to find the specified unit",
          details: {
            project: trimmedProjectName || null,
            unitCode: requestedUnitCode || null,
            unitName: trimmedUnitName || null
          }
        },
        { status: 404 }
      )
    }

    if (!project) {
      project = unit.projectId
        ? await db.project.findUnique({
            where: { id: unit.projectId },
            select: { id: true, name: true }
          })
        : null
    }

    // Find or create resident
    let resident = await db.resident.findFirst({
      where: {
        AND: [
          { name: trimmedResidentName },
          {
            unitId: unit.id
          }
        ]
      },
      include: {
        unit: {
          include: {
            project: true
          }
        }
      }
    })

    if (!resident) {
      resident = await db.resident.create({
        data: {
          name: trimmedResidentName,
          email: residentEmail || null,
          phone: residentPhone || null,
          unitId: unit.id,
          status: "ACTIVE"
        },
        include: {
          unit: {
            include: {
              project: true
            }
          }
        }
      })
    }

    // Update resident contact info if provided
    if (residentEmail || residentPhone) {
      resident = await db.resident.update({
        where: { id: resident.id },
        data: {
          ...(residentEmail && { email: residentEmail }),
          ...(residentPhone && { phone: residentPhone })
        },
        include: {
          unit: {
            include: {
              project: true
            }
          }
        }
      })
    }

    // Create ticket
    const ticket = await db.ticket.create({
      data: {
        title: trimmedTitle,
        description: trimmedDescription,
        priority: priority || "Normal",
        status: "NEW",
        residentId: resident!.id,
        unitId: unit.id
      }
    })

    const response = {
      success: true,
      ticketId: ticket.id,
      ticketNumber: `TICK-${ticket.id.substring(0, 8).toUpperCase()}`,
      resident: {
        id: resident!.id,
        name: resident!.name,
        email: resident!.email,
        phone: resident!.phone,
        unitCode: resident!.unit.code
      },
      message: "Ticket created successfully"
    }

    await notifyN8nEvent("TICKET_CREATED", {
      ticket: {
        id: ticket.id,
        title: trimmedTitle,
        description: trimmedDescription,
        priority: priority || "Normal",
        status: "NEW"
      },
      unit: {
        id: unit.id,
        code: unit.code,
        name: unit.name,
        project: project?.name ?? null
      },
      resident: {
        id: resident!.id,
        name: resident!.name,
        email: resident!.email,
        phone: resident!.phone
      }
    })

    await logWebhookEvent(
      auth.context.keyId,
      "TICKET_CREATED",
      "/api/webhooks/tickets",
      "POST",
      201,
      body,
      response,
      undefined,
      ipAddress
    )

    return NextResponse.json(response, { status: 201 })
  } catch (error) {
    console.error("Error creating ticket:", error)

    const auth = await verifyN8nApiKey(req)
    if (auth.context) {
      await logWebhookEvent(
        auth.context.keyId,
        "TICKET_CREATED",
        "/api/webhooks/tickets",
        "POST",
        500,
        undefined,
        { error: "Internal server error" },
        error instanceof Error ? error.message : "Unknown error",
        ipAddress
      )
    }

    return NextResponse.json(
      { error: "Failed to create ticket" },
      { status: 500 }
    )
  }
}
