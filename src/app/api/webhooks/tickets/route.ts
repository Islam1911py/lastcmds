import { NextRequest, NextResponse } from "next/server"
import { Prisma } from "@prisma/client"
import { db } from "@/lib/db"
import { verifyN8nApiKey, logWebhookEvent } from "@/lib/n8n-auth"
import { notifyN8nEvent } from "@/lib/n8n-notify"

type HumanReadable = {
  en?: string
  ar?: string
}

type Suggestion = {
  title: string
  prompt: string
  data?: Record<string, unknown>
}

type UnitWithProject = Prisma.OperationalUnitGetPayload<{
  include: { project: true }
}>

function formatDate(date: Date | string) {
  const parsed = typeof date === "string" ? new Date(date) : date
  if (!(parsed instanceof Date) || Number.isNaN(parsed.getTime())) {
    return null
  }

  try {
    return parsed.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    })
  } catch {
    return parsed.toISOString().split("T")[0] ?? null
  }
}

export async function POST(req: NextRequest) {
  const ipAddress = req.headers.get("x-forwarded-for") || "unknown"

  try {
    const body = await req.json()

    // Verify API key
    const auth = await verifyN8nApiKey(req)
    if (!auth.valid || !auth.context) {
      return NextResponse.json(
        {
          success: false,
          error: auth.error || "Unauthorized",
          humanReadable: {
            en: "API key failed verification, ticket webhook rejected.",
            ar: "مفتاح الـ API غير صالح، تم رفض تشغيل الويب هوك."
          },
          suggestions: [
            {
              title: "مراجعة بيانات API",
              prompt: "تأكد من استخدام مفتاح n8n الصحيح وتأكد أنه مفعّل في النظام."
            }
          ]
        },
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
        {
          success: false,
          error: "Only residents can create tickets",
          humanReadable: {
            en: "This webhook accepts resident credentials only.",
            ar: "هذا الويب هوك يقبل مفاتيح السكان فقط."
          },
          suggestions: [
            {
              title: "استخدم مفتاح الساكن",
              prompt: "أرسل الطلب بنفس مفتاح التكامل الخاص بالساكن الذي أنشأ التذكرة."
            }
          ]
        },
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
          success: false,
          error: "Missing required fields: residentName, title, description",
          humanReadable: {
            en: "Need resident name, ticket title, and description to log a request.",
            ar: "يجب إدخال اسم الساكن، العنوان، والوصف لتسجيل التذكرة."
          },
          suggestions: [
            {
              title: "إعادة إرسال البيانات",
              prompt: "أعد إرسال الطلب متضمناً اسم الساكن، عنوان واضح، ووصف للمشكلة."
            }
          ]
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
          success: false,
          error: "Missing unit details. Please provide building number or unit name.",
          humanReadable: {
            en: "Please include a unit code, building number, or unit name so we can route the ticket.",
            ar: "من فضلك أرسل كود الوحدة أو رقم المبنى أو اسم الوحدة لربط التذكرة بشكل صحيح."
          },
          suggestions: [
            {
              title: "تحديد الوحدة",
              prompt: "اذكر كود الوحدة أو اسمها كما هو مسجل في النظام."
            }
          ]
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
            success: false,
            error: "Project not found",
            requestedName: trimmedProjectName,
            humanReadable: {
              en: `No project matches "${trimmedProjectName}".` ,
              ar: `لا يوجد مشروع مطابق للاسم "${trimmedProjectName}".`
            },
            suggestions: [
              {
                title: "تأكيد اسم المشروع",
                prompt: "راجع اسم المشروع في لوحة الإدارة ثم أعد المحاولة."
              }
            ]
          },
          { status: 404 }
        )
      }
    }

    // Resolve unit by code/name within optional project scope
    let unit: UnitWithProject | null = null

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
          success: false,
          error: "Unable to find the specified unit",
          details: {
            project: trimmedProjectName || null,
            unitCode: requestedUnitCode || null,
            unitName: trimmedUnitName || null
          },
          humanReadable: {
            en: "Could not match the provided unit information to an existing unit.",
            ar: "تعذر العثور على وحدة مطابقة للبيانات المرسلة."
          },
          suggestions: [
            {
              title: "قائمة أكواد الوحدات",
              prompt: "اذكر لي أكواد أو أسماء الوحدات المتاحة في هذا المشروع للتأكد من الكود الصحيح.",
              data: {
                projectName: trimmedProjectName || null
              }
            }
          ]
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

    const ticketNumber = `TICK-${ticket.id.substring(0, 8).toUpperCase()}`
    const projectLabel = project?.name ?? unit.project?.name ?? resident!.unit.project?.name ?? null
    const unitLabel = unit.name ? `${unit.code} • ${unit.name}` : unit.code
    const createdAtLabel = formatDate(ticket.createdAt)
    const priorityLabel = (priority || "Normal").toString()

    const humanReadable: HumanReadable = {
      en: `New ticket ${ticketNumber} opened by ${resident!.name} for unit ${unitLabel}${projectLabel ? ` in project ${projectLabel}` : ""}. Priority: ${priorityLabel}${createdAtLabel ? ` on ${createdAtLabel}` : ""}.`,
      ar: `تم فتح تذكرة جديدة ${ticketNumber} بواسطة ${resident!.name} للوحدة ${unitLabel}${projectLabel ? ` في مشروع ${projectLabel}` : ""}. الأولوية: ${priorityLabel}${createdAtLabel ? ` بتاريخ ${createdAtLabel}` : ""}.`
    }

    const suggestions: Suggestion[] = [
      {
        title: "تعيين فني",
        prompt: `كلف فني مناسب للتذكرة ${ticketNumber} وحدد موعد الزيارة.` ,
        data: {
          ticketId: ticket.id,
          unitId: unit.id
        }
      },
      {
        title: "إبلاغ الساكن",
        prompt: `أرسل تأكيد للساكن ${resident!.name} بأن التذكرة ${ticketNumber} تحت المتابعة.` ,
        data: {
          residentId: resident!.id,
          ticketNumber
        }
      }
    ]

    const meta = {
      event: "TICKET_CREATED" as const,
      projectId: unit.project?.id ?? project?.id ?? resident!.unit.project?.id ?? null,
      projectName: projectLabel,
      unitId: unit.id,
      unitCode: unit.code,
      priority: priorityLabel,
      createdAt: ticket.createdAt,
      residentId: resident!.id
    }

    const response = {
      success: true,
      ticketId: ticket.id,
      ticketNumber,
      ticket: {
        id: ticket.id,
        title: trimmedTitle,
        description: trimmedDescription,
        priority: priorityLabel,
        status: "NEW",
        residentId: resident!.id,
        unitId: unit.id,
        createdAt: ticket.createdAt
      },
      resident: {
        id: resident!.id,
        name: resident!.name,
        email: resident!.email,
        phone: resident!.phone,
        unitCode: resident!.unit.code
      },
      unit: {
        id: unit.id,
        code: unit.code,
        name: unit.name,
        projectId: unit.project?.id ?? project?.id ?? null,
        projectName: projectLabel
      },
      meta,
      humanReadable,
      suggestions,
      message: "Ticket created successfully"
    }

    await notifyN8nEvent("TICKET_CREATED", {
      ticket: response.ticket,
      ticketNumber,
      resident: response.resident,
      unit: response.unit,
      meta,
      humanReadable,
      suggestions
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
      {
        success: false,
        error: "Failed to create ticket",
        humanReadable: {
          en: "Ticket creation failed due to an internal error.",
          ar: "فشل إنشاء التذكرة بسبب خطأ داخلي."
        },
        suggestions: [
          {
            title: "إعادة المحاولة لاحقاً",
            prompt: "حاول إعادة إرسال نفس الطلب بعد قليل أو تواصل مع فريق الدعم إذا استمرت المشكلة."
          }
        ]
      },
      { status: 500 }
    )
  }
}
