import { NextRequest, NextResponse } from "next/server"

import { db } from "@/lib/db"
import { verifyN8nApiKey, logWebhookEvent } from "@/lib/n8n-auth"
import { buildPhoneVariants } from "@/lib/phone"

const ENDPOINT = "/api/webhooks/project-managers"

const ALLOWED_ACTIONS = [
  "CREATE_OPERATIONAL_EXPENSE",
  "GET_RESIDENT_PHONE",
  "LIST_PROJECT_TICKETS"
] as const

type AllowedAction = (typeof ALLOWED_ACTIONS)[number]

type ActionMap = {
  CREATE_OPERATIONAL_EXPENSE: {
    projectId: string
    unitCode: string
    description: string
    amount: number | string
    sourceType: "OFFICE_FUND" | "PM_ADVANCE"
    pmAdvanceId?: string | null
    recordedAt?: string | null
  }
  GET_RESIDENT_PHONE: {
    projectId: string
    unitCode: string
    residentName?: string | null
    limit?: number | string
  }
  LIST_PROJECT_TICKETS: {
    projectId: string
    unitCode?: string | null
    statuses?: string[]
    limit?: number | string
  }
}

type RequestBody = {
  action?: string
  senderPhone?: string
  payload?: Record<string, unknown>
}

type ManagerRecord = NonNullable<Awaited<ReturnType<typeof resolveProjectManager>>>

type HumanReadable = {
  en?: string
  ar?: string
}

type Suggestion = {
  title: string
  prompt: string
  data?: Record<string, unknown>
}

type ActionSuccessPayload<Data = unknown> = {
  success: true
  projectId?: string | null
  data: Data
  meta?: Record<string, unknown>
  message?: string
  humanReadable?: HumanReadable
  suggestions?: Suggestion[]
}

type ActionErrorPayload = {
  success: false
  error: string
  issues?: Record<string, unknown>
  projectId?: string | null
  meta?: Record<string, unknown>
  humanReadable?: HumanReadable
  suggestions?: Suggestion[]
}

type HandlerResponse = {
  status: number
  body: ActionSuccessPayload | ActionErrorPayload
}

type ActionHandler<K extends AllowedAction> = (
  manager: ManagerRecord,
  payload: ActionMap[K]
) => Promise<HandlerResponse>

type GenericActionHandler = (
  manager: ManagerRecord,
  payload: Record<string, unknown>
) => Promise<HandlerResponse>

function buildManagerContext(manager: ManagerRecord) {
  return {
    id: manager.id,
    name: manager.name,
    phone: manager.whatsappPhone,
    canViewAllProjects: manager.canViewAllProjects,
    projects: manager.canViewAllProjects
      ? []
      : manager.assignedProjects.map((assignment) => ({
          id: assignment.projectId,
          name: assignment.project?.name ?? null
        }))
  }
}

function parseLimit(input: unknown, fallback = 5, max = 25) {
  const numeric = Number(input)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback
  }
  return Math.min(Math.trunc(numeric), max)
}

function formatCurrency(amount: number) {
  try {
    return amount.toLocaleString("en-US", {
      minimumFractionDigits: amount % 1 === 0 ? 0 : 2,
      maximumFractionDigits: 2
    })
  } catch {
    return String(amount)
  }
}

function formatDate(date: Date | null | undefined) {
  if (!date) {
    return null
  }

  try {
    return date.toLocaleDateString("en-GB", {
      day: "2-digit",
      month: "2-digit",
      year: "numeric"
    })
  } catch {
    return date.toISOString().split("T")[0] ?? null
  }
}

async function resolveProjectManager(senderPhone: string) {
  const phoneVariants = buildPhoneVariants(senderPhone)

  if (phoneVariants.length === 0) {
    return null
  }

  return db.user.findFirst({
    where: {
      role: "PROJECT_MANAGER",
      whatsappPhone: { in: phoneVariants }
    },
    include: {
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
}

function assertProjectAccess(
  manager: ManagerRecord | null,
  projectId: string
) {
  if (!manager) {
    return false
  }

  if (manager.canViewAllProjects) {
    return true
  }

  const assigned = manager.assignedProjects?.map((assignment) => assignment.projectId) ?? []
  return assigned.includes(projectId)
}

async function handleCreateOperationalExpense(
  manager: ManagerRecord,
  payload: ActionMap["CREATE_OPERATIONAL_EXPENSE"]
): Promise<HandlerResponse> {
  const { projectId, unitCode, description, amount, sourceType, pmAdvanceId, recordedAt } = payload

  const normalizedDescription = String(description ?? "").trim()
  const numericAmount = Number(amount)

  if (!projectId || !unitCode || !normalizedDescription || Number.isNaN(numericAmount) || numericAmount <= 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Missing or invalid fields for operational expense",
        projectId: projectId || null,
        humanReadable: {
          en: "I could not record the expense because some fields are missing or invalid.",
          ar: "لم أستطع تسجيل المصروف لأن بعض البيانات ناقصة أو غير صحيحة."
        },
        suggestions: [
          {
            title: "إرسال بيانات المصروف كاملة",
            prompt: "من فضلك أعد إرسال رقم المشروع، كود الوحدة، وصف واضح، قيمة موجبة، وحدد المصدر OFFICE_FUND أو PM_ADVANCE.",
            data: {
              requiredFields: ["projectId", "unitCode", "description", "amount", "sourceType"]
            }
          }
        ]
      }
    }
  }

  if (sourceType !== "OFFICE_FUND" && sourceType !== "PM_ADVANCE") {
    return {
      status: 400,
      body: {
        success: false,
        error: "Invalid sourceType. Use OFFICE_FUND or PM_ADVANCE",
        projectId,
        humanReadable: {
          en: "The expense source must be OFFICE_FUND or PM_ADVANCE.",
          ar: "المصدر يجب أن يكون OFFICE_FUND أو PM_ADVANCE."
        },
        suggestions: [
          {
            title: "ضبط نوع المصدر",
            prompt: "استخدم OFFICE_FUND للمصروفات من الخزنة أو PM_ADVANCE للمقدم الخاص بالمدير.",
            data: {
              acceptedValues: ["OFFICE_FUND", "PM_ADVANCE"]
            }
          }
        ]
      }
    }
  }

  const project = await db.project.findUnique({ where: { id: projectId } })

  if (!project) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Project not found",
        projectId,
        humanReadable: {
          en: "I could not find this project, so the expense was not recorded.",
          ar: "لم أجد هذا المشروع لذلك لم يتم تسجيل المصروف."
        },
        suggestions: [
          {
            title: "تأكيد رقم المشروع",
            prompt: "تأكد من رقم المشروع ثم أعد طلب تسجيل المصروف.",
            data: {
              attemptedProjectId: projectId
            }
          }
        ]
      }
    }
  }

  if (!assertProjectAccess(manager, projectId)) {
    return {
      status: 403,
      body: {
        success: false,
        error: "Project manager is not assigned to this project",
        projectId,
        humanReadable: {
          en: "You are not assigned to this project, so I stopped the expense.",
          ar: "أنت غير مكلّف بهذا المشروع لذلك أوقفت تسجيل المصروف."
        },
        suggestions: [
          {
            title: "طلب صلاحية المشروع",
            prompt: "من فضلك اطلب إضافة المشروع إلى صلاحياتي ثم أعد تسجيل المصروف.",
            data: {
              managerId: manager.id,
              projectId
            }
          }
        ]
      }
    }
  }

  const unit = await db.operationalUnit.findFirst({
    where: {
      projectId,
      code: unitCode
    }
  })

  if (!unit) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Operational unit not found for provided code",
        projectId,
        issues: { unitCode },
        humanReadable: {
          en: "I could not find an operational unit with that code inside the project.",
          ar: "لم أجد وحدة تشغيلية بهذا الكود داخل المشروع."
        },
        suggestions: [
          {
            title: "قائمة الأكواد المتاحة",
            prompt: "اذكر لي أكواد الوحدات المتاحة في هذا المشروع.",
            data: {
              projectId
            }
          }
        ]
      }
    }
  }

  let connectedPmAdvanceId: string | null = null
  let pmAdvanceRemaining: number | undefined

  if (sourceType === "PM_ADVANCE") {
    if (!pmAdvanceId) {
      return {
        status: 400,
        body: {
          success: false,
          error: "pmAdvanceId is required for PM_ADVANCE source",
          projectId,
          issues: { sourceType },
          humanReadable: {
            en: "Please specify which PM advance should fund this expense.",
            ar: "من فضلك حدد أي مقدم خاص بالمدير سيموّل هذا المصروف."
          },
          suggestions: [
            {
              title: "استعراض مقدمات المدير",
              prompt: "اعرض لي المقدمات المتاحة للمدير لهذا المشروع.",
              data: {
                projectId,
                managerId: manager.id
              }
            }
          ]
        }
      }
    }

    const pmAdvance = await db.pMAdvance.findUnique({
      where: { id: pmAdvanceId }
    })

    if (!pmAdvance) {
      return {
        status: 404,
        body: {
          success: false,
          error: "PM advance not found",
          projectId,
          issues: { pmAdvanceId },
          humanReadable: {
            en: "I could not find the referenced PM advance entry.",
            ar: "تعذر العثور على المقدم المحدد."
          },
          suggestions: [
            {
              title: "اختيار مقدم صحيح",
              prompt: "من فضلك استخدم معرف مقدم صحيح مرتبط بالمشروع الحالي.",
              data: {
                attemptedPmAdvanceId: pmAdvanceId
              }
            }
          ]
        }
      }
    }

    if (pmAdvance.projectId && pmAdvance.projectId !== projectId) {
      return {
        status: 403,
        body: {
          success: false,
          error: "PM advance does not belong to the provided project",
          projectId,
          issues: { pmAdvanceProjectId: pmAdvance.projectId },
          humanReadable: {
            en: "That PM advance is linked to another project.",
            ar: "هذا المقدم مرتبط بمشروع آخر."
          },
          suggestions: [
            {
              title: "تحديد مشروع المقدم",
              prompt: "اذكر لي المقدمات المرتبطة بالمشروع المطلوب.",
              data: {
                projectId,
                pmAdvanceProjectId: pmAdvance.projectId
              }
            }
          ]
        }
      }
    }

    if (pmAdvance.remainingAmount < numericAmount) {
      return {
        status: 400,
        body: {
          success: false,
          error: "Insufficient PM advance remaining balance",
          projectId,
          issues: {
            remaining: pmAdvance.remainingAmount,
            requested: numericAmount
          },
          humanReadable: {
            en: `The PM advance has ${formatCurrency(pmAdvance.remainingAmount)} remaining, which is less than the requested amount ${formatCurrency(numericAmount)}.`,
            ar: `المتبقي في المقدم ${formatCurrency(pmAdvance.remainingAmount)} وهو أقل من المطلوب ${formatCurrency(numericAmount)}.`
          },
          suggestions: [
            {
              title: "إبلاغ المدير بالمتبقي",
              prompt: `أخبر المدير أن المتبقي في المقدم هو ${formatCurrency(pmAdvance.remainingAmount)} فقط.`,
              data: {
                remaining: pmAdvance.remainingAmount,
                requested: numericAmount
              }
            }
          ]
        }
      }
    }

    pmAdvanceRemaining = pmAdvance.remainingAmount - numericAmount

    connectedPmAdvanceId = pmAdvance.id
  }

  let recordedAtDate: Date | undefined
  if (recordedAt) {
    const parsed = new Date(recordedAt)
    if (Number.isNaN(parsed.getTime())) {
      return {
        status: 400,
        body: {
          success: false,
          error: "Invalid recordedAt value",
          projectId,
          issues: { recordedAt },
          humanReadable: {
            en: "The recorded date is invalid. Please use an ISO format like 2024-05-01.",
            ar: "تاريخ التسجيل غير صالح. استخدم صيغة مثل 2024-05-01."
          },
          suggestions: [
            {
              title: "تصحيح التاريخ",
              prompt: "استخدم تاريخ بصيغة YYYY-MM-DD عند تسجيل المصروف.",
              data: {
                attemptedRecordedAt: recordedAt
              }
            }
          ]
        }
      }
    }
    recordedAtDate = parsed
  }

  const accountingNote = await db.accountingNote.create({
    data: {
      projectId,
      unitId: unit.id,
      createdByUserId: manager.id,
      description: normalizedDescription,
      amount: numericAmount,
      status: "PENDING",
      sourceType,
      pmAdvanceId: sourceType === "PM_ADVANCE" ? connectedPmAdvanceId : null
    },
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
      pmAdvance: {
        include: {
          staff: {
            select: { id: true, name: true }
          }
        }
      }
    }
  })

  const amountLabel = formatCurrency(accountingNote.amount)
  const unitDisplay = accountingNote.unit.name
    ? `${accountingNote.unit.code} • ${accountingNote.unit.name}`
    : accountingNote.unit.code
  const projectName = accountingNote.project?.name ?? accountingNote.unit.project?.name ?? null
  const sourceLabelEn = sourceType === "PM_ADVANCE" ? "PM advance" : "office fund"
  const sourceLabelAr = sourceType === "PM_ADVANCE" ? "مقدم المدير" : "خزنة المكتب"
  const recordedDateLabel = formatDate(recordedAtDate ?? accountingNote.createdAt)

  const humanReadable: HumanReadable = {
    en: `Created an accounting note for ${amountLabel} on unit ${unitDisplay}${projectName ? ` in project ${projectName}` : ""} from the ${sourceLabelEn}. Waiting for accountant review${recordedDateLabel ? ` (submitted ${recordedDateLabel})` : ""}.`,
    ar: `تم إنشاء مذكرة محاسبية بقيمة ${amountLabel} للوحدة ${unitDisplay}${projectName ? ` ضمن مشروع ${projectName}` : ""} من ${sourceLabelAr}. بانتظار مراجعة المحاسب${recordedDateLabel ? ` (أُرسلت ${recordedDateLabel})` : ""}.`
  }

  const suggestions: Suggestion[] = [
    {
      title: "متابعة حالة المذكرة",
      prompt: "ما حالة المذكرة المحاسبية الأخيرة التي سجلتها؟",
      data: {
        projectId,
        unitCode
      }
    }
  ]

  return {
    status: 201,
    body: {
      success: true,
      projectId,
      message: "Accounting note submitted",
      meta: {
        unitCode,
        sourceType,
        pmAdvanceRemaining
      },
      data: {
        accountingNote
      },
      humanReadable,
      suggestions
    }
  }
}

async function handleResidentLookup(
  manager: ManagerRecord,
  payload: ActionMap["GET_RESIDENT_PHONE"]
): Promise<HandlerResponse> {
  const { projectId, unitCode, residentName, limit } = payload

  if (!projectId || !unitCode) {
    return {
      status: 400,
      body: {
        success: false,
        error: "projectId and unitCode are required",
        projectId: projectId || null,
        humanReadable: {
          en: "Please include both the project ID and the unit code so I can locate the residents.",
          ar: "من فضلك أرسل رقم المشروع وكود الوحدة حتى أستطيع العثور على السكان."
        },
        suggestions: [
          {
            title: "تهيئة طلب الاستعلام",
            prompt: "استخدم رقم المشروع وكود الوحدة معاً عندما تطلب بيانات السكان.",
            data: {
              requiredFields: ["projectId", "unitCode"]
            }
          }
        ]
      }
    }
  }

  if (!assertProjectAccess(manager, projectId)) {
    return {
      status: 403,
      body: {
        success: false,
        error: "Project manager is not assigned to this project",
        projectId,
        humanReadable: {
          en: "You are not assigned to this project, so I cannot share its residents.",
          ar: "أنت غير مكلّف بهذا المشروع لذلك لا يمكنني مشاركة بيانات سكانه."
        },
        suggestions: [
          {
            title: "طلب إضافة المشروع",
            prompt: "اطلب إضافة هذا المشروع لصلاحياتي ثم حاول مرة أخرى."
          }
        ]
      }
    }
  }

  const unit = await db.operationalUnit.findFirst({
    where: {
      projectId,
      code: unitCode
    }
  })

  if (!unit) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Operational unit not found",
        projectId,
        issues: { unitCode },
        humanReadable: {
          en: "I could not find a unit with that code inside the project.",
          ar: "لم أجد وحدة بهذا الكود داخل المشروع."
        },
        suggestions: [
          {
            title: "عرض أكواد الوحدات",
            prompt: "اذكر لي أكواد الوحدات المتاحة في هذا المشروع.",
            data: {
              projectId
            }
          }
        ]
      }
    }
  }

  const take = parseLimit(limit, 5, 20)

  const residents = await db.resident.findMany({
    where: {
      unitId: unit.id,
      ...(residentName
        ? {
            name: {
              contains: residentName
            }
          }
        : {})
    },
    select: {
      id: true,
      name: true,
      phone: true,
      whatsappPhone: true
    },
    orderBy: { name: "asc" },
    take
  })

  const namesSample = residents.slice(0, 3).map((resident) => resident.name ?? "ساكن بدون اسم")
  const firstResident = residents[0]
  const humanReadable: HumanReadable = residents.length
    ? {
        en: `Found ${residents.length} resident${residents.length === 1 ? "" : "s"} in unit ${unitCode}: ${namesSample.join(", ")}.`,
        ar: `تم العثور على ${residents.length} من السكان في الوحدة ${unitCode}: ${namesSample.join("، ")}.`
      }
    : {
        en: `No residents matched unit ${unitCode}.`,
        ar: `لم يتم العثور على سكان للوحدة ${unitCode}.`
      }

  const suggestions: Suggestion[] = residents.length
    ? [
        firstResident
          ? {
              title: `التواصل مع ${firstResident.name ?? "أول ساكن"}`,
              prompt: `جهز رسالة واتساب إلى ${firstResident.name ?? "السكان"} على الرقم ${firstResident.whatsappPhone ?? firstResident.phone}.`,
              data: {
                residentId: firstResident.id,
                phone: firstResident.whatsappPhone ?? firstResident.phone
              }
            }
          : undefined,
        {
          title: "عرض جميع السكان",
          prompt: `اعرض جميع السكان في الوحدة ${unitCode} ببيانات الاتصال الخاصة بهم.`,
          data: {
            projectId,
            unitCode
          }
        }
      ].filter(Boolean) as Suggestion[]
    : [
        {
          title: "مراجعة كود الوحدة",
          prompt: "تأكد من كود الوحدة أو جرب وحدة أخرى في نفس المشروع.",
          data: {
            projectId,
            unitCode
          }
        }
      ]

  return {
    status: 200,
    body: {
      success: true,
      projectId,
      meta: {
        unitCode,
        count: residents.length
      },
      data: {
        residents
      },
      message: residents.length === 0 ? "لا توجد بيانات سكان للوحدة" : undefined,
      humanReadable,
      suggestions
    }
  }
}

async function handleTicketSummary(
  manager: ManagerRecord,
  payload: ActionMap["LIST_PROJECT_TICKETS"]
): Promise<HandlerResponse> {
  const { projectId, unitCode, statuses, limit } = payload

  if (!projectId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "projectId is required",
        projectId: null,
        humanReadable: {
          en: "I need the project ID to check its tickets.",
          ar: "أحتاج رقم المشروع لمراجعة التذاكر الخاصة به."
        },
        suggestions: [
          {
            title: "إرسال رقم المشروع",
            prompt: "ضمّن رقم المشروع عندما تطلب ملخص التذاكر."
          }
        ]
      }
    }
  }

  if (!assertProjectAccess(manager, projectId)) {
    return {
      status: 403,
      body: {
        success: false,
        error: "Project manager is not assigned to this project",
        projectId,
        humanReadable: {
          en: "You are not assigned to this project, so I cannot share the tickets.",
          ar: "أنت غير مكلّف بهذا المشروع لذلك لا يمكنني مشاركة التذاكر الخاصة به."
        },
        suggestions: [
          {
            title: "طلب إضافة المشروع",
            prompt: "اطلب إضافة المشروع لصلاحياتي ثم أعد طلب ملخص التذاكر."
          }
        ]
      }
    }
  }

  const validStatuses = Array.isArray(statuses)
    ? statuses.filter((status): status is "NEW" | "IN_PROGRESS" | "DONE" =>
        status === "NEW" || status === "IN_PROGRESS" || status === "DONE"
      )
    : []

  const take = parseLimit(limit, 5, 20)

  const tickets = await db.ticket.findMany({
    where: {
      unit: {
        projectId,
        ...(unitCode ? { code: unitCode } : {})
      },
      ...(validStatuses.length > 0 ? { status: { in: validStatuses } } : {})
    },
    select: {
      id: true,
      title: true,
      status: true,
      priority: true,
      createdAt: true,
      updatedAt: true,
      unit: {
        select: {
          id: true,
          code: true,
          name: true
        }
      }
    },
    orderBy: { createdAt: "desc" },
    take
  })

  const statusCounts = tickets.reduce(
    (acc, ticket) => {
      acc.total += 1
      acc[ticket.status] = (acc[ticket.status] ?? 0) + 1
      return acc
    },
    { total: 0, NEW: 0, IN_PROGRESS: 0, DONE: 0 } as Record<string, number>
  )

  const scopeLabel = unitCode ? `unit ${unitCode}` : "all units"
  const filteredStatusesLabel = validStatuses.length ? validStatuses.join(", ") : "all statuses"
  const firstTicket = tickets[0]

  const humanReadable: HumanReadable = tickets.length
    ? {
        en: `Found ${tickets.length} tickets for ${scopeLabel} (${filteredStatusesLabel}). NEW: ${statusCounts.NEW}, IN_PROGRESS: ${statusCounts.IN_PROGRESS}, DONE: ${statusCounts.DONE}.`,
        ar: `تم العثور على ${tickets.length} تذكرة لـ ${unitCode ? `الوحدة ${unitCode}` : "جميع الوحدات"} (${filteredStatusesLabel}). جديد: ${statusCounts.NEW}، قيد التنفيذ: ${statusCounts.IN_PROGRESS}، منجز: ${statusCounts.DONE}.`
      }
    : {
        en: `No tickets matched the filters for ${scopeLabel}.`,
        ar: `لا توجد تذاكر مطابقة للمحددات لـ ${unitCode ? `الوحدة ${unitCode}` : "المشروع"}.`
      }

  const suggestions: Suggestion[] = tickets.length
    ? [
        firstTicket
          ? {
              title: "متابعة أول تذكرة",
              prompt: `أعطني تفاصيل التذكرة ${firstTicket.id} مع آخر تحديث لها.`,
              data: {
                ticketId: firstTicket.id,
                status: firstTicket.status
              }
            }
          : undefined,
        {
          title: "تلخيص الحالات",
          prompt: "لخّص حالة التذاكر في المشروع مع أولوية الأعلى خطورة."
        }
      ].filter(Boolean) as Suggestion[]
    : [
        {
          title: "تخفيف المحددات",
          prompt: "جرب إزالة المحددات أو زيادة الحد الأقصى للنتائج لرؤية تذاكر أخرى.",
          data: {
            limit,
            statuses: validStatuses
          }
        }
      ]

  return {
    status: 200,
    body: {
      success: true,
      projectId,
      meta: {
        unitCode: unitCode ?? null,
        statuses: validStatuses,
        count: tickets.length
      },
      data: {
        tickets
      },
      message: tickets.length === 0 ? "لا توجد تذاكر بالمحددات الحالية" : undefined,
      humanReadable,
      suggestions
    }
  }
}

const actionHandlers: Record<AllowedAction, GenericActionHandler> = {
  CREATE_OPERATIONAL_EXPENSE: handleCreateOperationalExpense as GenericActionHandler,
  GET_RESIDENT_PHONE: handleResidentLookup as GenericActionHandler,
  LIST_PROJECT_TICKETS: handleTicketSummary as GenericActionHandler
}

const EVENT_TYPES: Record<AllowedAction, "PM_OPERATIONAL_EXPENSE_CREATED" | "PM_RESIDENT_LOOKUP" | "PM_TICKETS_SUMMARY"> = {
  CREATE_OPERATIONAL_EXPENSE: "PM_OPERATIONAL_EXPENSE_CREATED",
  GET_RESIDENT_PHONE: "PM_RESIDENT_LOOKUP",
  LIST_PROJECT_TICKETS: "PM_TICKETS_SUMMARY"
}

export async function POST(req: NextRequest) {
  const ipAddress = req.headers.get("x-forwarded-for") || "unknown"
  let requestBody: RequestBody | null = null

  try {
    requestBody = await req.json()
  } catch (error) {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const auth = await verifyN8nApiKey(req)
  if (!auth.valid || !auth.context) {
    return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 })
  }

  if (auth.context.role !== "PROJECT_MANAGER" && auth.context.role !== "ADMIN") {
    await logWebhookEvent(
      auth.context.keyId,
      "PM_TICKETS_SUMMARY",
      ENDPOINT,
      "POST",
      403,
      requestBody,
      { error: "API key not permitted for project manager actions" },
      "API key not permitted for project manager actions",
      ipAddress
    )

    return NextResponse.json({ error: "Forbidden" }, { status: 403 })
  }

  const action = requestBody?.action
  const senderPhone = String(requestBody?.senderPhone ?? "").trim()
  const payload = requestBody?.payload ?? {}

  if (!action || !ALLOWED_ACTIONS.includes(action as AllowedAction)) {
    return NextResponse.json({ error: "Unsupported action" }, { status: 400 })
  }

  if (!senderPhone) {
    return NextResponse.json({ error: "senderPhone is required" }, { status: 400 })
  }

  const manager = await resolveProjectManager(senderPhone)

  if (!manager) {
    await logWebhookEvent(
      auth.context.keyId,
      EVENT_TYPES[action as AllowedAction],
      ENDPOINT,
      "POST",
      404,
      requestBody,
      { error: "Project manager not found for sender phone" },
      "Project manager not found for phone",
      ipAddress
    )

    return NextResponse.json(
      { error: "Project manager not found for sender phone" },
      { status: 404 }
    )
  }

  const handler = actionHandlers[action as AllowedAction]
  const actionPayload = payload as ActionMap[AllowedAction]

  let response

  const managerContext = buildManagerContext(manager)

  try {
    response = await handler(manager, actionPayload)
  } catch (error) {
    console.error("Project manager webhook error:", error)
    response = {
      status: 500,
      body: { success: false, error: "Internal server error" }
    }
  }

  const projectIdFromPayload =
    (actionPayload as { projectId?: string | null })?.projectId ??
    (response.body as ActionSuccessPayload | ActionErrorPayload).projectId ??
    null

  const enrichedBody = response.body.success
    ? {
        success: true,
        action,
        manager: managerContext,
        projectId: projectIdFromPayload,
        meta: {
          managerName: manager.name,
          ...(response.body as ActionSuccessPayload).meta
        },
        data: (response.body as ActionSuccessPayload).data,
        message: (response.body as ActionSuccessPayload).message,
        humanReadable: (response.body as ActionSuccessPayload).humanReadable,
        suggestions: (response.body as ActionSuccessPayload).suggestions
      }
    : {
        success: false,
        action,
        manager: managerContext,
        projectId: projectIdFromPayload,
        error: (response.body as ActionErrorPayload).error,
        issues: (response.body as ActionErrorPayload).issues,
        meta: {
          managerName: manager.name,
          ...(response.body as ActionErrorPayload).meta
        },
        humanReadable: (response.body as ActionErrorPayload).humanReadable,
        suggestions: (response.body as ActionErrorPayload).suggestions
      }

  await logWebhookEvent(
    auth.context.keyId,
    EVENT_TYPES[action as AllowedAction],
    ENDPOINT,
    "POST",
    response.status,
    requestBody,
    enrichedBody,
    response.status >= 400 ? (enrichedBody as any)?.error : undefined,
    ipAddress
  )

  return NextResponse.json(enrichedBody, { status: response.status })
}
