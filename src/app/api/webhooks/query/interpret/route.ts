import { NextRequest, NextResponse } from "next/server"

import { db } from "@/lib/db"
import { verifyN8nApiKey, logWebhookEvent } from "@/lib/n8n-auth"

const TICKET_KEYWORDS = [
  "شكوى",
  "شكاوي",
  "شكايه",
  "تذكرة",
  "تذاكر",
  "بلاغ",
  "بلاغات",
  "مشكلة",
  "مشاكل",
  "اشتكى",
  "اشتكوا",
  "صيانة",
  "maintenance",
  "issue",
  "problem",
  "تسريب",
  "leak",
  "سباكة",
  "plumbing",
  "كهرباء",
  "electricity",
  "ticket",
  "complaint"
]

const EXPENSE_KEYWORDS = [
  "مصروف",
  "مصاريف",
  "صرف",
  "صرفنا",
  "expense",
  "electric",
  "كهرب",
  "فاتورة",
  "فواتير",
  "تكلفة",
  "ميزانية",
  "budget",
  "cost"
]

const ACCOUNTING_KEYWORDS = [
  "تحصيل",
  "دفعة",
  "دفعات",
  "invoice",
  "فواتير",
  "pending",
  "محاسبه",
  "مدفوعات",
  "balance",
  "رصيد",
  "متأخرات",
  "تحصيلات",
  "debt",
  "collections"
]

const PROJECT_SUMMARY_KEYWORDS = [
  "ملخص",
  "وضع",
  "overview",
  "حالة",
  "status",
  "تفاصيل المشروع",
  "تفاصيل",
  "بيانات",
  "dashboard",
  "report",
  "إحصائيات",
  "احصائية",
  "اخبار"
]

const RESIDENT_KEYWORDS = [
  "ساكن",
  "سكان",
  "المقيم",
  "المقيمين",
  "residents",
  "resident",
  "ساكنين",
  "عدد السكان",
  "عدد الساكن",
  "قائمة السكان"
]

const RESIDENT_CONTACT_KEYWORDS = [
  "رقم",
  "رقمها",
  "رقمه",
  "رقمها",
  "تليفون",
  "تلفون",
  "تليفونه",
  "اتصال",
  "اتصل",
  "واتساب",
  "whatsapp",
  "contact",
  "phone"
]

const PARAM_DISPLAY_LABEL: Record<string, string> = {
  senderPhone: "رقم واتساب المدير",
  projectId: "معرف المشروع",
  unitCode: "كود الوحدة",
  residentName: "اسم الساكن",
  limit: "الحد الأقصى",
  statuses: "حالات التذاكر"
}

const TICKET_TOPIC_KEYWORDS: Array<{ label: string; tokens: string[] }> = [
  {
    label: "السباكة",
    tokens: ["سباكة", "plumbing", "مواسير", "تسريب", "leak", "صرف صحي"]
  },
  {
    label: "الكهرباء",
    tokens: ["كهرب", "كهرباء", "electric", "electricity", "قاطع", "نور"]
  },
  {
    label: "المياه",
    tokens: ["مياه", "ماء", "water", "خزان", "ضعف المياه"]
  },
  {
    label: "النظافة",
    tokens: ["نظافة", "clean", "قمامة", "زبالة"]
  },
  {
    label: "الأمن",
    tokens: ["امن", "أمن", "security", "حراسة", "بوابة"]
  },
  {
    label: "الصيانة العامة",
    tokens: ["صيانة", "maintenance", "تصليح", "fix"]
  },
  {
    label: "المصاعد",
    tokens: ["مصعد", "اسنصير", "elevator", "lift"]
  }
]

const RANGE_KEYWORDS: Record<string, string[]> = {
  TODAY: ["اليوم", "النهارده", "انهارده", "today", "دلوقتي"],
  WEEK: ["اسبوع", "أسبوع", "7", "7 ايام", "سبعة"],
  MONTH: ["شهر", "30", "٣٠", "31", "٣١"],
  ALL: ["كل", "جميع", "على طول", "طول"],
}

const STATUS_KEYWORDS: Record<string, string[]> = {
  NEW: ["جديد", "جديدة", "فتح", "مفتوحة"],
  IN_PROGRESS: ["جار", "قيد", "شغال"],
  DONE: ["مقفل", "مغلق", "خلص", "انتهت", "closed", "منتهي"],
}

type Role = "ADMIN" | "ACCOUNTANT" | "PROJECT_MANAGER"

type Suggestion = {
  title: string
  prompt: string
  data?: Record<string, unknown>
}

type InterpretationCandidate = {
  id: string
  confidence: number
  role: Role
  description: string
  missingParameters: string[]
  searchTerms: string[]
  http: {
    method: "GET" | "POST"
    endpoint: string
    query?: Record<string, string | null>
    payload?: Record<string, unknown>
  }
  requiredParameters: string[]
  optionalParameters: string[]
  postProcess: string[]
  humanReadable: {
    en?: string
    ar?: string
  }
}

function normalize(text: string) {
  return text.trim().toLowerCase()
}

function detectKeywords(question: string, keywords: string[]) {
  const normalizedQuestion = normalize(question)
  return keywords.filter((keyword) => normalizedQuestion.includes(keyword))
}

function detectTicketTopics(question: string) {
  const normalizedQuestion = normalize(question)
  const topics = new Set<string>()

  for (const topic of TICKET_TOPIC_KEYWORDS) {
    if (topic.tokens.some((token) => normalizedQuestion.includes(normalize(token)))) {
      topics.add(topic.label)
    }
  }

  return Array.from(topics)
}

function detectRange(question: string) {
  const normalizedQuestion = normalize(question)
  for (const [range, tokens] of Object.entries(RANGE_KEYWORDS)) {
    if (tokens.some((token) => normalizedQuestion.includes(token))) {
      return range
    }
  }
  return null
}

function detectStatuses(question: string) {
  const normalizedQuestion = normalize(question)
  const statuses = new Set<"NEW" | "IN_PROGRESS" | "DONE">()
  for (const [status, tokens] of Object.entries(STATUS_KEYWORDS)) {
    if (tokens.some((token) => normalizedQuestion.includes(token))) {
      statuses.add(status as "NEW" | "IN_PROGRESS" | "DONE")
    }
  }
  return Array.from(statuses)
}

function detectLimit(question: string, fallback = 5) {
  const limitMatch = question.match(/(\d+)/)
  if (!limitMatch) {
    return fallback
  }
  const numeric = Number(limitMatch[1])
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback
  }
  return Math.min(Math.trunc(numeric), 25)
}

function detectUnitCode(question: string) {
  const unitRegex = /(?:كود\s+الوحدة|وحدة|شقة|unit|flat)\s+([A-Za-z0-9\-_/]+)/i
  const match = question.match(unitRegex)
  if (match && match[1]) {
    return match[1].trim()
  }
  return null
}

async function matchProject(question: string, explicitProjectName?: string | null) {
  const projectNameHint = explicitProjectName?.trim() ?? null
  const normalizedQuestion = normalize(question)
  const projects = await db.project.findMany({
    select: { id: true, name: true },
    orderBy: { name: "asc" }
  })

  for (const project of projects) {
    const normalizedProject = normalize(project.name)
    if (normalizedProject && normalizedQuestion.includes(normalizedProject)) {
      return { ...project, matchedBy: "question" as const }
    }
    if (projectNameHint && normalize(projectNameHint) === normalizedProject) {
      return { ...project, matchedBy: "hint" as const }
    }
  }

  if (projectNameHint) {
    const fallback = projects.find((project) => normalize(project.name) === normalize(projectNameHint))
    if (fallback) {
      return { ...fallback, matchedBy: "hint" as const }
    }
  }

  return null
}

function buildTicketCandidate(options: {
  role: Role
  projectId?: string | null
  projectName?: string | null
  statuses: ("NEW" | "IN_PROGRESS" | "DONE")[]
  range: string | null
  limit: number
  question: string
  matchedKeywords: string[]
  topics: string[]
}): InterpretationCandidate {
  const requiredParameters: string[] = ["senderPhone"]
  const missingParameters: string[] = ["senderPhone"]
  const optionalParameters: string[] = ["statuses", "limit"]
  if (!options.projectId) {
    requiredParameters.push("projectId")
    missingParameters.push("projectId")
  }
  if (options.range) {
    optionalParameters.push("range")
  }

  const searchTerms = Array.from(new Set([...options.matchedKeywords, ...options.topics]))

  const payload: Record<string, unknown> = {
    action: "LIST_PROJECT_TICKETS",
    senderPhone: "{{pmPhone}}",
    payload: {
      projectId: options.projectId ?? "{{projectId}}",
      limit: options.limit,
      ...(options.statuses.length > 0 ? { statuses: options.statuses } : {}),
    }
  }

  return {
    id: "project-manager-list-tickets",
    confidence: Math.min(
      0.92,
      0.55 + (options.projectId ? 0.2 : 0) + options.matchedKeywords.length * 0.05 + options.topics.length * 0.03
    ),
    role: options.role,
    description: "قائمة التذاكر للمشروع المحدد مع دعم تحديد الحالة والعدد",
    missingParameters,
    searchTerms,
    http: {
      method: "POST",
      endpoint: "/api/webhooks/project-managers",
      payload
    },
    requiredParameters,
    optionalParameters,
    postProcess: [
      options.range
        ? `فلترة النتائج زمنيًا بحسب ${options.range}`
        : "ترتيب التذاكر تنازليًا حسب createdAt",
      "عرض رقم التذكرة والعنوان والحالة والساكن إن وجد",
      options.topics.length > 0
        ? `تركيز التحليل على التذاكر المتعلقة بـ ${options.topics.join(" و ")}`
        : "تحديد التذاكر الأكثر صلة بالوصف الوارد في السؤال"
    ],
    humanReadable: {
      ar: `استخدم إجراء LIST_PROJECT_TICKETS لاسترجاع أحدث التذاكر للمشروع${options.projectName ? ` ${options.projectName}` : ""}${
        options.topics.length > 0 ? ` مع التركيز على ${options.topics.join(" و ")}` : ""
      }.`
    }
  }
}

function buildExpenseCandidate(options: {
  role: Role
  projectId?: string | null
  projectName?: string | null
  range: string | null
  question: string
  matchedKeywords: string[]
}) {
  const requiredParameters: string[] = []
  const optionalParameters: string[] = ["range", "unit", "date"]
  const missingParameters: string[] = []
  if (!options.projectId) {
    requiredParameters.push("projectId")
    missingParameters.push("projectId")
  }

  const query: Record<string, string | null> = {
    type: "LAST_EXPENSE",
    projectId: options.projectId ?? "{{projectId}}"
  }

  if (options.range && options.range !== "ALL") {
    query.range = options.range
  }

  const expenseKeywords = options.matchedKeywords.filter((keyword) => keyword.includes("كهرب"))
  const searchTerms = Array.from(new Set(options.matchedKeywords))

  return {
    id: "project-manager-last-expense",
    confidence: Math.min(0.85, 0.5 + (options.projectId ? 0.25 : 0) + (options.range ? 0.1 : 0)),
    role: options.role,
    description: "استعلام عن آخر المصروفات للمشروع مع إمكانية تصفية إضافية",
    missingParameters,
    searchTerms,
    http: {
      method: "GET",
      endpoint: "/api/webhooks/query",
      query
    },
    requiredParameters,
    optionalParameters,
    postProcess: [
      expenseKeywords.length > 0
        ? "تجميع النتائج التي تحتوي على كلمة كهربا/كهرباء في الوصف وحساب الإجمالي"
        : "تقديم ملخص لأهم المصروفات الحديثة مع الإجمالي المطلوب",
      "عرض الوحدة، الوصف، والقيمة لكل مصروف"
    ],
    humanReadable: {
      ar: `استخدم استعلام LAST_EXPENSE لسحب أحدث المصروفات للمشروع${options.projectName ? ` ${options.projectName}` : ""}. بعد استلام النتائج قم بتصفية البنود ذات الصلة بالسؤال ثم اعرض الإجمالي.`
    }
  } satisfies InterpretationCandidate
}

function buildAccountingCandidate(role: Role): InterpretationCandidate {
  return {
    id: "accountant-summary",
    confidence: 0.6,
    role,
    description: "لوحة المحاسب: فواتير، مدفوعات، ملاحظات معلقة",
    missingParameters: [],
    searchTerms: ["محاسبة", "فواتير", "مدفوعات"],
    http: {
      method: "GET",
      endpoint: "/api/webhooks/query",
      query: {
        type: "ACCOUNTING_DATA"
      }
    },
    requiredParameters: [],
    optionalParameters: [],
    postProcess: ["تلخيص التحصيلات والمبالغ المتبقية", "عرض الملاحظات المحاسبية المعلقة"],
    humanReadable: {
      ar: "استخدم type=ACCOUNTING_DATA للحصول على ملخص الفواتير والتحصيلات." }
  }
}

function buildAdminCandidate(role: Role): InterpretationCandidate {
  return {
    id: "admin-overview",
    confidence: 0.55,
    role,
    description: "ملخص شامل للمشروعات والوحدات والسكان والتذاكر",
    missingParameters: [],
    searchTerms: ["ملخص", "dashboard"],
    http: {
      method: "GET",
      endpoint: "/api/webhooks/query",
      query: {
        type: "ALL_DATA"
      }
    },
    requiredParameters: [],
    optionalParameters: [],
    postProcess: ["تحديد الأرقام المهمة للطلب الإداري", "استخراج أي عناصر تحتاج متابعة"],
    humanReadable: {
      ar: "استخدم type=ALL_DATA للحصول على نظرة عامة على المنصة ثم استخرج الجزء المطلوب من البيانات." }
  }
}

function buildProjectDataCandidate(options: {
  role: Role
  projectId?: string | null
  projectName?: string | null
  question: string
  matchedKeywords: string[]
}): InterpretationCandidate {
  const requiredParameters: string[] = []
  const optionalParameters: string[] = ["senderPhone"]

  if (!options.projectId) {
    requiredParameters.push("projectId")
  }

  const missingParameters: string[] = []
  if (!options.projectId) {
    missingParameters.push("projectId")
  }

  return {
    id: "project-data-summary",
    confidence: Math.min(0.88, 0.55 + (options.projectId ? 0.25 : 0) + options.matchedKeywords.length * 0.05),
    role: options.role,
    description: "ملخص المشروع مع عدد الوحدات والسكان والتذاكر",
    missingParameters,
    searchTerms: Array.from(new Set(options.matchedKeywords)),
    http: {
      method: "GET",
      endpoint: "/api/webhooks/query",
      query: {
        type: "PROJECT_DATA",
        projectId: options.projectId ?? "{{projectId}}"
      }
    },
    requiredParameters,
    optionalParameters,
    postProcess: [
      "اقرأ الحقل summary.totalResidents للإجابة عن عدد السكان",
      "استخدم المصفوفة residents لعرض الأسماء والوحدات عند الحاجة",
      "انقل المعلومات المطلوبة باللغة العربية مع ذكر اسم المشروع إن توفر"
    ],
    humanReadable: {
      ar: `استخدم استعلام PROJECT_DATA للحصول على عدد السكان والوحدات${options.projectName ? ` للمشروع ${options.projectName}` : ""}.`
    }
  }
}

function buildResidentPhoneCandidate(options: {
  role: Role
  projectId?: string | null
  projectName?: string | null
  unitCode?: string | null
}): InterpretationCandidate {
  const requiredParameters: string[] = ["senderPhone", "projectId", "unitCode"]
  const missingParameters = requiredParameters.filter((param) => {
    if (param === "projectId") {
      return !options.projectId
    }
    if (param === "unitCode") {
      return !options.unitCode
    }
    return true
  })

  return {
    id: "project-manager-resident-phone",
    confidence: Math.min(0.88, 0.6 + (options.projectId ? 0.2 : 0)),
    role: options.role,
    description: "جلب رقم تواصل الساكن لوحدة محددة داخل المشروع",
    missingParameters,
    searchTerms: options.unitCode ? [options.unitCode] : [],
    http: {
      method: "POST",
      endpoint: "/api/webhooks/project-managers",
      payload: {
        action: "GET_RESIDENT_PHONE",
        senderPhone: "{{pmPhone}}",
        payload: {
          projectId: options.projectId ?? "{{projectId}}",
          unitCode: options.unitCode ?? "{{unitCode}}"
        }
      }
    },
    requiredParameters,
    optionalParameters: ["residentName", "limit"],
    postProcess: [
      "تحقق أن الاستجابة تحتوي على residents ثم اعرض الاسم والرقم",
      "أخبر المستخدم إذا تمت إعادة أكثر من ساكن واطلب تحديد الاسم عند الحاجة"
    ],
    humanReadable: {
      ar: `استخدم إجراء GET_RESIDENT_PHONE لاسترجاع رقم الساكن للوحدة المطلوبة${options.projectName ? ` داخل ${options.projectName}` : ""}.`
    }
  }
}

export async function POST(req: NextRequest) {
  const ipAddress = req.headers.get("x-forwarded-for") || "unknown"

  try {
    const body = await req.json()
    const auth = await verifyN8nApiKey(req)

    if (!auth.valid || !auth.context) {
      return NextResponse.json({ error: auth.error || "Unauthorized" }, { status: 401 })
    }

    const question = String(body?.question ?? "").trim()
    const explicitProjectName = body?.projectName ? String(body.projectName) : undefined
    const preferredRole = body?.role as Role | undefined

    if (question.length === 0) {
      return NextResponse.json(
        {
          success: false,
          error: "question is required",
          humanReadable: {
            en: "Provide a natural-language question to interpret.",
            ar: "من فضلك أرسل السؤال الطبيعي المطلوب تحويله." }
        },
        { status: 400 }
      )
    }

    const role: Role = preferredRole ?? (auth.context.role as Role) ?? "PROJECT_MANAGER"
    const normalizedQuestion = question.toLowerCase()

    const matchedTickets = detectKeywords(normalizedQuestion, TICKET_KEYWORDS)
    const matchedExpenses = detectKeywords(normalizedQuestion, EXPENSE_KEYWORDS)
    const matchedAccounting = detectKeywords(normalizedQuestion, ACCOUNTING_KEYWORDS)
    const matchedSummary = detectKeywords(normalizedQuestion, PROJECT_SUMMARY_KEYWORDS)
    const matchedResidents = detectKeywords(normalizedQuestion, RESIDENT_KEYWORDS)
    const matchedResidentContact = detectKeywords(normalizedQuestion, RESIDENT_CONTACT_KEYWORDS)
    const mentionsUnit =
      normalizedQuestion.includes("وحدة") ||
      normalizedQuestion.includes("شقة") ||
      normalizedQuestion.includes("unit") ||
      normalizedQuestion.includes("flat")

    const range = detectRange(normalizedQuestion)
    const statuses = detectStatuses(normalizedQuestion)
    const limit = detectLimit(normalizedQuestion)
    const unitCode = detectUnitCode(question)

    const projectMatch = await matchProject(question, explicitProjectName)
    const ticketTopics = detectTicketTopics(question)

    const candidates: InterpretationCandidate[] = []

    if (matchedTickets.length > 0 || normalizedQuestion.includes("ticket")) {
      candidates.push(
        buildTicketCandidate({
          role,
          projectId: projectMatch?.id ?? null,
          projectName: projectMatch?.name ?? null,
          statuses,
          range,
          limit,
          question,
          matchedKeywords: matchedTickets,
          topics: ticketTopics
        })
      )
    }

    if (matchedExpenses.length > 0) {
      candidates.push(
        buildExpenseCandidate({
          role,
          projectId: projectMatch?.id ?? null,
          projectName: projectMatch?.name ?? null,
          range,
          question,
          matchedKeywords: matchedExpenses
        })
      )
    }

    if (role === "ACCOUNTANT" || matchedAccounting.length > 0) {
      candidates.push(buildAccountingCandidate(role))
    }

    if (role === "ADMIN" || matchedSummary.length > 0) {
      candidates.push(buildAdminCandidate(role))
    }

    if (matchedResidents.length > 0 || normalizedQuestion.includes("resident")) {
      candidates.push(
        buildProjectDataCandidate({
          role,
          projectId: projectMatch?.id ?? null,
          projectName: projectMatch?.name ?? null,
          question,
          matchedKeywords: matchedResidents
        })
      )
    }

    if (matchedResidentContact.length > 0 && (matchedResidents.length > 0 || mentionsUnit)) {
      candidates.push(
        buildResidentPhoneCandidate({
          role,
          projectId: projectMatch?.id ?? null,
          projectName: projectMatch?.name ?? null,
          unitCode
        })
      )
    }

    const sortedCandidates = candidates.sort((a, b) => b.confidence - a.confidence)

    const success = sortedCandidates.length > 0

    const suggestions: Suggestion[] = success
      ? []
      : [
          {
            title: "تحديد نوع البيانات",
            prompt: "هل السؤال متعلق بالمصروفات، التذاكر، أو ملخص إداري؟"
          }
        ]

    if (success) {
      const topCandidate = sortedCandidates[0]
      if (topCandidate.missingParameters.length > 0) {
        const missingLabels = topCandidate.missingParameters.map(
          (param) => PARAM_DISPLAY_LABEL[param] ?? param
        )
        suggestions.push({
          title: "تجهيز البيانات المطلوبة",
          prompt: `أرسل ${missingLabels.join(" و ")} لإكمال الطلب الحالي.`,
          data: {
            missingParameters: topCandidate.missingParameters
          }
        })
      }
    }

    const humanReadable = success
      ? {
          ar: `تم تحليل السؤال وتقديم ${sortedCandidates.length} اختيار(ات) لاستعلامات مناسبة${projectMatch ? ` بناءً على المشروع ${projectMatch.name}` : ""}.`
        }
      : {
          ar: "لم يتم التعرف على نوع السؤال. فضلاً وضّح إذا كان يتعلق بتذاكر، مصروفات، أو ملخص مشروع."
        }

    const responseBody = {
      success,
      question,
      role,
      projectMatch,
      range: range ?? null,
      statuses,
      limit,
      candidates: sortedCandidates,
      humanReadable,
      suggestions
    }

    await logWebhookEvent(
      auth.context.keyId,
      "QUERY_INTERPRETED",
      "/api/webhooks/query/interpret",
      "POST",
      success ? 200 : 422,
      body,
      responseBody,
      success ? undefined : "Unrecognized question",
      ipAddress
    )

    return NextResponse.json(responseBody, { status: success ? 200 : 422 })
  } catch (error) {
    console.error("Interpretation error:", error)

    const auth = await verifyN8nApiKey(req)
    if (auth.context) {
      await logWebhookEvent(
        auth.context.keyId,
        "QUERY_INTERPRETED",
        "/api/webhooks/query/interpret",
        "POST",
        500,
        undefined,
        { error: "Internal server error" },
        error instanceof Error ? error.message : "Unknown error",
        req.headers.get("x-forwarded-for") || "unknown"
      )
    }

    return NextResponse.json(
      {
        success: false,
        error: "Failed to interpret question"
      },
      { status: 500 }
    )
  }
}
