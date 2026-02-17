import { NextRequest, NextResponse } from "next/server"
import type { Prisma } from "@prisma/client"

import { db } from "@/lib/db"
import {
  analyzeExpenseSearch,
  buildDescriptionFilter,
  EXPENSE_SOURCE_TYPES,
  type ExpenseSourceType
} from "@/lib/expense-search"
import { verifyN8nApiKey, logWebhookEvent } from "@/lib/n8n-auth"
import { buildPhoneVariants } from "@/lib/phone"
import {
  resolveStaffReference,
  searchStaffByName,
  buildStaffAdvancesSummary,
  type StaffSearchMatch,
  type StaffResolution
} from "@/lib/staff-search"

const ENDPOINT = "/api/webhooks/accountants"

const ALLOWED_ACTIONS = [
  "CREATE_PM_ADVANCE",
  "CREATE_STAFF_ADVANCE",
  "UPDATE_STAFF_ADVANCE",
  "DELETE_STAFF_ADVANCE",
  "RECORD_ACCOUNTING_NOTE",
  "PAY_INVOICE",
  "CREATE_PAYROLL",
  "PAY_PAYROLL",
  "LIST_UNIT_EXPENSES",
  "SEARCH_STAFF",
  "LIST_STAFF_ADVANCES",
  "SEARCH_ACCOUNTING_NOTES"
] as const

type AllowedAction = (typeof ALLOWED_ACTIONS)[number]

type ActionMap = {
  CREATE_PM_ADVANCE: {
    staffId?: string | null
    staffQuery?: string | null
    amount: number | string
    projectId?: string | null
    notes?: string | null
  }
  CREATE_STAFF_ADVANCE: {
    staffId?: string | null
    staffQuery?: string | null
    amount: number | string
    note?: string | null
  }
  UPDATE_STAFF_ADVANCE: {
    advanceId: string
    amount?: number | string | null
    note?: string | null
    staffQuery?: string | null
  }
  DELETE_STAFF_ADVANCE: {
    advanceId: string
    staffQuery?: string | null
  }
  RECORD_ACCOUNTING_NOTE: {
    noteId: string
    sourceType?: "OFFICE_FUND" | "PM_ADVANCE"
    pmAdvanceId?: string | null
  }
  PAY_INVOICE: {
    invoiceId: string
    amount?: number | string | null
    action?: "pay" | "mark-paid"
  }
  CREATE_PAYROLL: {
    month: string
  }
  PAY_PAYROLL: {
    payrollId: string
  }
  LIST_UNIT_EXPENSES: {
    projectId?: string | null
    unitCode?: string | null
    limit?: number | string
    sourceTypes?: Array<
      "TECHNICIAN_WORK" | "STAFF_WORK" | "ELECTRICITY" | "OTHER"
    >
    search?: string | null
    fromDate?: string | null
    toDate?: string | null
  }
  SEARCH_STAFF: {
    query: string
    projectId?: string | null
    limit?: number | string
    onlyWithPendingAdvances?: boolean
  }
  LIST_STAFF_ADVANCES: {
    query?: string | null
    status?: "PENDING" | "DEDUCTED" | "ALL"
    projectId?: string | null
    limit?: number | string
  }
  SEARCH_ACCOUNTING_NOTES: {
    query?: string | null
    status?: "PENDING" | "CONVERTED" | "REJECTED" | "ALL"
    projectId?: string | null
    unitCode?: string | null
    limit?: number | string
    includeConverted?: boolean
  }
}

type RequestBody = {
  action?: string
  senderPhone?: string
  payload?: Record<string, unknown>
}

type AccountantRecord = NonNullable<Awaited<ReturnType<typeof resolveAccountant>>>

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
  data: Data
  message?: string
  humanReadable?: HumanReadable
  suggestions?: Suggestion[]
  meta?: Record<string, unknown>
}

type ActionErrorPayload = {
  success: false
  error: string
  issues?: Record<string, unknown>
  humanReadable?: HumanReadable
  suggestions?: Suggestion[]
  meta?: Record<string, unknown>
}

type HandlerResponse = {
  status: number
  body: ActionSuccessPayload | ActionErrorPayload
}

type ActionHandler<K extends AllowedAction> = (
  accountant: AccountantRecord,
  payload: ActionMap[K]
) => Promise<HandlerResponse>

function buildStaffMatchPayload(match: StaffSearchMatch) {
  return {
    id: match.id,
    name: match.name,
    unitId: match.unitId,
    unitCode: match.unitCode,
    projectId: match.projectId,
    projectName: match.projectName,
    score: match.score,
    pendingAdvanceCount: match.pendingAdvanceCount,
    pendingAdvanceAmount: Number(match.pendingAdvanceAmount.toFixed(2)),
    pendingAdvanceIds: match.pendingAdvanceIds,
    tokens: match.tokens,
    matchBreakdown: match.matchBreakdown
  }
}

function buildStaffSearchMeta(resolution: StaffResolution) {
  return {
    normalizedQuery: resolution.normalizedQuery,
    tokens: resolution.tokens,
    matches: resolution.matches.map((match) => buildStaffMatchPayload(match)),
    chosen: resolution.staff ? buildStaffMatchPayload(resolution.staff) : null
  }
}

function parseLimit(input: unknown, fallback = 10, max = 50) {
  const numeric = Number(input)
  if (!Number.isFinite(numeric) || numeric <= 0) {
    return fallback
  }
  return Math.min(Math.trunc(numeric), max)
}

function parseDateInput(value: unknown, label: string): Date | null {
  if (value === null || value === undefined || value === "") {
    return null
  }

  if (typeof value !== "string") {
    throw new Error(`${label} must be an ISO date string`)
  }

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(`${label} is invalid; use YYYY-MM-DD`)
  }

  return parsed
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

function formatDate(date: Date | string | null | undefined) {
  if (!date) {
    return null
  }

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

function normalizeInvoice(invoice: any) {
  if (!invoice) {
    return null
  }

  const unitExpenses = (invoice.expenses ?? []).map((expense: any) => ({
    ...expense,
    date: expense.date ?? expense.createdAt ?? null,
    createdAt: expense.createdAt ?? null,
    sourceType: expense.sourceType ?? "UNIT_EXPENSE"
  }))

  const operationalExpenses = (invoice.operationalExpenses ?? []).map((expense: any) => ({
    id: expense.id,
    description: expense.description,
    amount: expense.amount,
    sourceType: expense.sourceType,
    date: expense.recordedAt ?? expense.createdAt ?? null,
    createdAt: expense.createdAt ?? null
  }))

  const mergedExpenses = [...unitExpenses, ...operationalExpenses].sort((a, b) => {
    const aTime = a.date ? new Date(a.date).getTime() : 0
    const bTime = b.date ? new Date(b.date).getTime() : 0
    return bTime - aTime
  })

  const {
    operationalExpenses: _op,
    expenses: _unitExpenses,
    payments: _payments,
    ownerAssociation: rawOwnerAssociation,
    ...rest
  } = invoice

  const ownerContacts = rawOwnerAssociation?.contacts ?? []
  const primaryPhone = ownerContacts.find(
    (contact: any) => contact.type === "PHONE" && contact.isPrimary
  )?.value
  const primaryEmail = ownerContacts.find(
    (contact: any) => contact.type === "EMAIL" && contact.isPrimary
  )?.value

  const ownerAssociation = rawOwnerAssociation
    ? {
        ...rawOwnerAssociation,
        phone: primaryPhone ?? rawOwnerAssociation.phone ?? null,
        email: primaryEmail ?? rawOwnerAssociation.email ?? null,
        contacts: ownerContacts
      }
    : null

  return {
    ...rest,
    expenses: mergedExpenses,
    payments: invoice.payments ?? [],
    ownerAssociation
  }
}

async function resolveAccountant(senderPhone: string) {
  const phoneVariants = buildPhoneVariants(senderPhone)

  if (phoneVariants.length === 0) {
    return null
  }

  return db.user.findFirst({
    where: {
      whatsappPhone: { in: phoneVariants },
      role: {
        in: ["ACCOUNTANT", "ADMIN"]
      }
    },
    select: {
      id: true,
      name: true,
      role: true,
      whatsappPhone: true
    }
  })
}

async function handleCreatePmAdvance(
  accountant: AccountantRecord,
  payload: ActionMap["CREATE_PM_ADVANCE"]
): Promise<HandlerResponse> {
  const { staffId, staffQuery, amount, projectId, notes } = payload
  const numericAmount = Number(amount)

  if (Number.isNaN(numericAmount) || numericAmount <= 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Missing or invalid fields for PM advance",
        humanReadable: {
          en: "Please send a positive amount for the PM advance.",
          ar: "من فضلك أرسل قيمة موجبة لتسجيل العهدة."
        }
      }
    }
  }

  const staffResolution = await resolveStaffReference({
    staffId,
    staffQuery,
    projectId
  })

  if (!staffResolution.staff) {
    const matches = staffResolution.matches
    const notFound = matches.length === 0

    return {
      status: notFound ? 404 : 409,
      body: {
        success: false,
        error: notFound ? "Staff member not found" : "Staff match requires confirmation",
        humanReadable: {
          en: notFound
            ? "I could not find a staff member matching that description."
            : "I found multiple staff members; please confirm which one should receive the PM advance.",
          ar: notFound
            ? "لم أعثر على موظف مطابق للوصف."
            : "وجدت أكثر من موظف مطابق، من فضلك حدد الموظف المطلوب لتسجيل العهدة."
        },
        suggestions: matches.length
          ? [
              {
                title: "تأكيد اسم الموظف",
                prompt: "حدد اسم الموظف المقصود لتسجيل العهدة.",
                data: {
                  candidates: matches.map((match) => ({
                    id: match.id,
                    name: match.name,
                    score: match.score,
                    unitCode: match.unitCode,
                    projectId: match.projectId
                  }))
                }
              }
            ]
          : undefined,
        meta: {
          staffSearch: buildStaffSearchMeta(staffResolution)
        }
      }
    }
  }

  if (projectId) {
    const project = await db.project.findUnique({
      where: { id: projectId },
      select: { id: true }
    })

    if (!project) {
      return {
        status: 404,
        body: {
          success: false,
          error: "Project not found",
          humanReadable: {
            en: "The specified project does not exist.",
            ar: "المشروع المحدد غير موجود."
          }
        }
      }
    }
  }

  const advance = await db.pMAdvance.create({
    data: {
      staffId: staffResolution.staff.id,
      projectId: projectId || null,
      amount: numericAmount,
      remainingAmount: numericAmount,
      notes: notes ? String(notes).trim() || null : null
    },
    include: {
      staff: {
        select: { id: true, name: true }
      },
      project: {
        select: { id: true, name: true }
      }
    }
  })

  return {
    status: 201,
    body: {
      success: true,
      data: advance,
      message: "PM advance created",
      humanReadable: {
        en: `Advance of ${formatCurrency(advance.amount)} recorded successfully.`,
        ar: `تم تسجيل عهدة بقيمة ${formatCurrency(advance.amount)} بنجاح.`
      },
      meta: {
        staffSearch: buildStaffSearchMeta(staffResolution),
        staffAdvances: buildStaffAdvancesSummary(staffResolution.staff)
      }
    }
  }
}

async function handleCreateStaffAdvance(
  accountant: AccountantRecord,
  payload: ActionMap["CREATE_STAFF_ADVANCE"]
): Promise<HandlerResponse> {
  const { staffId, staffQuery, amount, note } = payload
  const numericAmount = Number(amount)

  if (Number.isNaN(numericAmount) || numericAmount <= 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Missing or invalid fields for staff advance",
        humanReadable: {
          en: "A positive amount is required to create a staff advance.",
          ar: "القيمة يجب أن تكون موجبة لتسجيل سلفة الموظف."
        }
      }
    }
  }

  const staffResolution = await resolveStaffReference({
    staffId,
    staffQuery,
    onlyWithPendingAdvances: true
  })

  if (!staffResolution.staff) {
    const matches = staffResolution.matches
    const notFound = matches.length === 0

    return {
      status: notFound ? 404 : 409,
      body: {
        success: false,
        error: notFound ? "Staff member not found" : "Staff match requires confirmation",
        humanReadable: {
          en: notFound
            ? "I could not find a staff member matching that description."
            : "I found multiple staff members; please confirm who should receive the advance.",
          ar: notFound
            ? "لم أعثر على موظف مطابق للوصف."
            : "وجدت أكثر من موظف مطابق، من فضلك حدد الموظف الذي تُصرف له السلفة."
        },
        suggestions: matches.length
          ? [
              {
                title: "تأكيد اسم الموظف",
                prompt: "اختر أو وضّح الموظف الذي تريده للسلفة.",
                data: {
                  candidates: matches.map((match) => ({
                    id: match.id,
                    name: match.name,
                    score: match.score,
                    unitCode: match.unitCode,
                    projectId: match.projectId
                  }))
                }
              }
            ]
          : undefined,
        meta: {
          staffSearch: buildStaffSearchMeta(staffResolution)
        }
      }
    }
  }

  const advance = await db.staffAdvance.create({
    data: {
      staffId: staffResolution.staff.id,
      amount: numericAmount,
      note: note ? String(note).trim() || null : null,
      status: "PENDING",
      date: new Date()
    },
    include: {
      staff: {
        select: { id: true, name: true }
      }
    }
  })

  const baseSummary = buildStaffAdvancesSummary(staffResolution.staff)
  const updatedSummary = baseSummary
    ? {
        ...baseSummary,
        pendingAdvanceCount: baseSummary.pendingAdvanceCount + 1,
        pendingAdvanceAmount: Number((baseSummary.pendingAdvanceAmount + numericAmount).toFixed(2)),
        pendingAdvanceIds: [...baseSummary.pendingAdvanceIds, advance.id]
      }
    : null

  return {
    status: 201,
    body: {
      success: true,
      data: advance,
      message: "Staff advance created",
      humanReadable: {
        en: `Staff advance of ${formatCurrency(advance.amount)} recorded successfully.`,
        ar: `تم تسجيل سلفة بقيمة ${formatCurrency(advance.amount)} بنجاح.`
      },
      meta: {
        staffSearch: buildStaffSearchMeta(staffResolution),
        staffAdvances: updatedSummary
      }
    }
  }
}

async function handleUpdateStaffAdvance(
  accountant: AccountantRecord,
  payload: ActionMap["UPDATE_STAFF_ADVANCE"]
): Promise<HandlerResponse> {
  const { advanceId, amount, note, staffQuery } = payload

  if (!advanceId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Advance id is required",
        humanReadable: {
          en: "Please send the advance id to update it.",
          ar: "من فضلك أرسل معرف السلفة لتعديلها."
        }
      }
    }
  }

  if (amount === undefined && note === undefined) {
    return {
      status: 400,
      body: {
        success: false,
        error: "No changes provided",
        humanReadable: {
          en: "Send a new amount or note to update the advance.",
          ar: "أرسل قيمة أو ملاحظة جديدة لتعديل السلفة."
        }
      }
    }
  }

  const queryResolution = staffQuery
    ? await resolveStaffReference({ staffQuery, onlyWithPendingAdvances: true })
    : null

  const advance = await db.staffAdvance.findUnique({
    where: { id: advanceId },
    include: {
      staff: {
        select: { id: true, name: true }
      }
    }
  })

  if (!advance) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Advance not found",
        humanReadable: {
          en: "I could not find a staff advance with that id.",
          ar: "لم أعثر على سلفة بهذا المعرف."
        },
        meta: queryResolution
          ? {
              staffSearch: buildStaffSearchMeta(queryResolution)
            }
          : undefined
      }
    }
  }

  if (advance.status !== "PENDING") {
    return {
      status: 400,
      body: {
        success: false,
        error: "Only pending advances can be edited",
        humanReadable: {
          en: "This advance is already deducted and cannot be edited.",
          ar: "هذه السلفة تم خصمها ولا يمكن تعديلها."
        }
      }
    }
  }

  const staffResolution = await resolveStaffReference({
    staffId: advance.staffId,
    staffQuery,
    onlyWithPendingAdvances: true
  })

  const updateData: Record<string, unknown> = {}
  let amountDelta = 0

  if (amount !== undefined && amount !== null) {
    const numericAmount = Number(amount)

    if (Number.isNaN(numericAmount) || numericAmount <= 0) {
      return {
        status: 400,
        body: {
          success: false,
          error: "Amount must be a positive number",
          humanReadable: {
            en: "Use a positive number for the advance amount.",
            ar: "القيمة يجب أن تكون رقماً موجباً."
          },
          meta: {
            staffSearch: buildStaffSearchMeta(staffResolution)
          }
        }
      }
    }

    amountDelta = numericAmount - advance.amount
    updateData.amount = numericAmount
  }

  if (note !== undefined) {
    updateData.note = note ? String(note).trim() || null : null
  }

  const updatedAdvance = await db.staffAdvance.update({
    where: { id: advanceId },
    data: updateData,
    include: {
      staff: {
        select: { id: true, name: true }
      }
    }
  })

  const baseSummary = buildStaffAdvancesSummary(staffResolution.staff)
  const adjustedSummary = baseSummary
    ? {
        ...baseSummary,
        pendingAdvanceAmount: Number((baseSummary.pendingAdvanceAmount + amountDelta).toFixed(2))
      }
    : null

  return {
    status: 200,
    body: {
      success: true,
      data: updatedAdvance,
      message: "Staff advance updated",
      humanReadable: {
        en: "Staff advance updated successfully.",
        ar: "تم تعديل السلفة بنجاح."
      },
      meta: {
        staffSearch: buildStaffSearchMeta(staffResolution),
        staffAdvances: adjustedSummary
      }
    }
  }
}

async function handleDeleteStaffAdvance(
  accountant: AccountantRecord,
  payload: ActionMap["DELETE_STAFF_ADVANCE"]
): Promise<HandlerResponse> {
  const { advanceId, staffQuery } = payload

  if (!advanceId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Advance id is required",
        humanReadable: {
          en: "Please send the advance id to delete it.",
          ar: "من فضلك أرسل معرف السلفة لحذفها."
        }
      }
    }
  }

  const queryResolution = staffQuery
    ? await resolveStaffReference({ staffQuery, onlyWithPendingAdvances: true })
    : null

  const advance = await db.staffAdvance.findUnique({
    where: { id: advanceId }
  })

  if (!advance) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Advance not found",
        humanReadable: {
          en: "I could not find a staff advance with that id.",
          ar: "لم أعثر على سلفة بهذا المعرف."
        },
        meta: queryResolution
          ? {
              staffSearch: buildStaffSearchMeta(queryResolution)
            }
          : undefined
      }
    }
  }

  if (advance.status === "DEDUCTED") {
    return {
      status: 400,
      body: {
        success: false,
        error: "Cannot delete deducted advances",
        humanReadable: {
          en: "This advance is already deducted and cannot be removed.",
          ar: "هذه السلفة تم خصمها ولا يمكن حذفها."
        },
        meta: queryResolution
          ? {
              staffSearch: buildStaffSearchMeta(queryResolution)
            }
          : undefined
      }
    }
  }

  const staffResolution = await resolveStaffReference({
    staffId: advance.staffId,
    staffQuery,
    onlyWithPendingAdvances: true
  })

  await db.staffAdvance.delete({
    where: { id: advanceId }
  })

  const baseSummary = buildStaffAdvancesSummary(staffResolution.staff)
  const adjustedSummary = baseSummary
    ? {
        ...baseSummary,
        pendingAdvanceCount: Math.max(0, baseSummary.pendingAdvanceCount - 1),
        pendingAdvanceAmount: Number((baseSummary.pendingAdvanceAmount - advance.amount).toFixed(2)),
        pendingAdvanceIds: baseSummary.pendingAdvanceIds.filter((id) => id !== advanceId)
      }
    : null

  return {
    status: 200,
    body: {
      success: true,
      data: { advanceId },
      message: "Staff advance deleted",
      humanReadable: {
        en: "Staff advance deleted successfully.",
        ar: "تم حذف السلفة بنجاح."
      },
      meta: {
        staffSearch: buildStaffSearchMeta(staffResolution),
        staffAdvances: adjustedSummary
      }
    }
  }
}

async function handleRecordAccountingNote(
  accountant: AccountantRecord,
  payload: ActionMap["RECORD_ACCOUNTING_NOTE"]
): Promise<HandlerResponse> {
  const { noteId, sourceType, pmAdvanceId } = payload

  if (!noteId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Note id is required",
        humanReadable: {
          en: "Send the accounting note id to record it.",
          ar: "أرسل معرف القيد المحاسبي لتسجيله."
        }
      }
    }
  }

  const note = await db.accountingNote.findUnique({
    where: { id: noteId },
    include: {
      unit: {
        include: {
          project: true
        }
      },
      project: true,
      pmAdvance: true
    }
  })

  if (!note) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Accounting note not found",
        humanReadable: {
          en: "I could not find an accounting note with that id.",
          ar: "لم أعثر على قيد محاسبي بهذا المعرف."
        }
      }
    }
  }

  if (note.status !== "PENDING") {
    return {
      status: 400,
      body: {
        success: false,
        error: "This note is already processed",
        humanReadable: {
          en: "The accounting note was already recorded earlier.",
          ar: "تم تسجيل هذا القيد مسبقاً."
        }
      }
    }
  }

  if (!note.unit) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Accounting note is missing unit information",
        humanReadable: {
          en: "This note has no unit linked to it.",
          ar: "لا يوجد وحدة مرتبطة بهذا القيد."
        }
      }
    }
  }

  const resolvedSourceType = sourceType ?? (note.sourceType as "OFFICE_FUND" | "PM_ADVANCE" | null) ?? "OFFICE_FUND"
  const resolvedPmAdvanceId = pmAdvanceId ?? note.pmAdvanceId ?? null

  if (resolvedSourceType === "PM_ADVANCE" && !resolvedPmAdvanceId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "PM advance is required for PM source",
        humanReadable: {
          en: "Select which PM advance should fund this expense.",
          ar: "حدد العهدة التي سيموّل منها هذا المصروف."
        }
      }
    }
  }

  if (resolvedSourceType === "PM_ADVANCE" && resolvedPmAdvanceId) {
    const pmAdvance = await db.pMAdvance.findUnique({
      where: { id: resolvedPmAdvanceId }
    })

    if (!pmAdvance) {
      return {
        status: 404,
        body: {
          success: false,
          error: "PM advance not found",
          humanReadable: {
            en: "I could not find that PM advance.",
            ar: "لم أعثر على هذه العهدة."
          }
        }
      }
    }

    if (pmAdvance.remainingAmount < note.amount) {
      return {
        status: 400,
        body: {
          success: false,
          error: "Insufficient PM advance balance",
          issues: {
            remaining: pmAdvance.remainingAmount,
            needed: note.amount
          },
          humanReadable: {
            en: "This PM advance does not have enough balance.",
            ar: "العهدة لا تحتوي على رصيد كافٍ."
          }
        }
      }
    }
  }

  let ownerAssociation = await db.ownerAssociation.findFirst({
    where: { unitId: note.unitId }
  })

  if (!ownerAssociation) {
    ownerAssociation = await db.ownerAssociation.create({
      data: {
        name: `Owner - ${note.unit.name}`,
        unitId: note.unitId,
        phone: "",
        email: ""
      }
    })
  }

  const invoiceNumber = `CLM-${Date.now()}-${note.unit.code}`

  const invoice = await db.invoice.create({
    data: {
      invoiceNumber,
      type: "CLAIM",
      unitId: note.unitId,
      ownerAssociationId: ownerAssociation.id,
      amount: note.amount,
      remainingBalance: note.amount
    }
  })

  const expense = await db.operationalExpense.create({
    data: {
      description: note.description,
      amount: note.amount,
      sourceType: resolvedSourceType,
      unitId: note.unitId,
      claimInvoiceId: invoice.id,
      recordedByUserId: accountant.id,
      pmAdvanceId: resolvedSourceType === "PM_ADVANCE" ? resolvedPmAdvanceId : null,
      convertedFromNoteId: note.id
    }
  })

  if (resolvedSourceType === "PM_ADVANCE" && resolvedPmAdvanceId) {
    await db.pMAdvance.update({
      where: { id: resolvedPmAdvanceId },
      data: {
        remainingAmount: {
          decrement: note.amount
        }
      }
    })
  }

  await db.accountingNote.update({
    where: { id: note.id },
    data: {
      status: "CONVERTED",
      convertedAt: new Date(),
      convertedToExpenseId: expense.id,
      pmAdvanceId: resolvedSourceType === "PM_ADVANCE" ? resolvedPmAdvanceId : null,
      sourceType: resolvedSourceType
    }
  })

  const refreshedNote = await db.accountingNote.findUnique({
    where: { id: note.id },
    include: {
      convertedToExpense: true,
      pmAdvance: true,
      unit: {
        include: {
          project: true
        }
      }
    }
  })

  return {
    status: 200,
    body: {
      success: true,
      data: {
        note: refreshedNote,
        invoice,
        expense
      },
      message: "Accounting note recorded",
      humanReadable: {
        en: "Accounting note converted to an invoice successfully.",
        ar: "تم تحويل القيد إلى فاتورة بنجاح."
      }
    }
  }
}

async function handleSearchStaff(
  accountant: AccountantRecord,
  payload: ActionMap["SEARCH_STAFF"]
): Promise<HandlerResponse> {
  const { query, projectId, limit, onlyWithPendingAdvances } = payload

  if (!query || !String(query).trim()) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Search query is required",
        humanReadable: {
          en: "Send a name or part of a name to search for staff.",
          ar: "أرسل اسم أو جزء من اسم للبحث عن الموظفين."
        }
      }
    }
  }

  const resolvedLimit = parseLimit(limit, 10, 50)
  const searchResult = await searchStaffByName({
    query,
    projectId: projectId ?? undefined,
    limit: resolvedLimit,
    onlyWithPendingAdvances: Boolean(onlyWithPendingAdvances)
  })

  const matches = searchResult.matches.map((match) => buildStaffMatchPayload(match))
  const summary = buildStaffAdvancesSummary(searchResult.staff)

  return {
    status: 200,
    body: {
      success: true,
      data: {
        matches
      },
      message: matches.length ? "Staff search completed" : "No staff matched the query",
      humanReadable: matches.length
        ? {
            en: `Found ${matches.length} staff${matches.length === 1 ? "" : " members"} matching the query.`,
            ar: `تم العثور على ${matches.length} موظف${matches.length === 1 ? "" : "ين"} مطابقين للبحث.`
          }
        : {
            en: "No staff matched the provided name.",
            ar: "لا يوجد موظفون مطابقون للاسم المرسل."
          },
      meta: {
        staffSearch: buildStaffSearchMeta(searchResult),
        staffAdvances: summary
      }
    }
  }
}

async function handleListStaffAdvances(
  accountant: AccountantRecord,
  payload: ActionMap["LIST_STAFF_ADVANCES"]
): Promise<HandlerResponse> {
  const { query, status, projectId, limit } = payload

  const resolvedLimit = parseLimit(limit, 25, 200)
  const statusFilter = status && status !== "ALL" ? status : undefined

  let staffSearchResolution: StaffResolution | null = null
  let staffIds: string[] | undefined

  if (query && String(query).trim()) {
    staffSearchResolution = await searchStaffByName({
      query,
      projectId: projectId ?? undefined,
      limit: Math.max(resolvedLimit, 10),
      onlyWithPendingAdvances: statusFilter === "PENDING"
    })

    staffIds = staffSearchResolution.matches.map((match) => match.id)

    if (staffIds.length === 0) {
      return {
        status: 200,
        body: {
          success: true,
          data: {
            advances: []
          },
          message: "No staff advances found",
          humanReadable: {
            en: "No staff advances matched the provided filters.",
            ar: "لا توجد سلف للموظفين مطابقة للمحددات."
          },
          meta: {
            staffSearch: buildStaffSearchMeta(staffSearchResolution)
          }
        }
      }
    }
  }

  const whereClauses: Prisma.StaffAdvanceWhereInput[] = []

  if (statusFilter) {
    whereClauses.push({ status: statusFilter })
  }

  if (staffIds && staffIds.length) {
    whereClauses.push({ staffId: { in: staffIds } })
  }

  if (projectId) {
    whereClauses.push({
      staff: {
        OR: [
          {
            unit: {
              projectId
            }
          },
          {
            projectAssignments: {
              some: {
                projectId
              }
            }
          }
        ]
      }
    })
  }

  const where: Prisma.StaffAdvanceWhereInput =
    whereClauses.length === 0
      ? {}
      : whereClauses.length === 1
        ? whereClauses[0]
        : { AND: whereClauses }

  const advances = await db.staffAdvance.findMany({
    where,
    take: resolvedLimit,
    orderBy: {
      createdAt: "desc"
    },
    include: {
      staff: {
        select: {
          id: true,
          name: true,
          unit: {
            select: {
              id: true,
              code: true,
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
      },
      payroll: {
        select: {
          id: true,
          month: true,
          status: true
        }
      }
    }
  })

  const items = advances.map((advance) => ({
    id: advance.id,
    staffId: advance.staffId,
    staffName: advance.staff?.name ?? null,
    amount: advance.amount,
    status: advance.status,
    date: advance.date,
    note: advance.note ?? null,
    unitCode: advance.staff?.unit?.code ?? null,
    projectId: advance.staff?.unit?.projectId ?? null,
    projectName: advance.staff?.unit?.project?.name ?? null,
    payrollId: advance.deductedFromPayrollId ?? null,
    payrollMonth: advance.payroll?.month ?? null
  }))

  const totalAmount = items.reduce((sum, item) => sum + (item.amount ?? 0), 0)
  const pendingCount = items.filter((item) => item.status === "PENDING").length
  const deductedCount = items.filter((item) => item.status === "DEDUCTED").length

  return {
    status: 200,
    body: {
      success: true,
      data: {
        advances: items
      },
      humanReadable: items.length
        ? {
            en: `Found ${items.length} staff advances totalling ${formatCurrency(totalAmount)}.`,
            ar: `تم العثور على ${items.length} سلفة بإجمالي ${formatCurrency(totalAmount)}.`
          }
        : {
            en: "No staff advances matched the filters.",
            ar: "لا توجد سلف مطابقة للمحددات."
          },
      meta: {
        filters: {
          status: statusFilter ?? "ALL",
          projectId: projectId ?? null
        },
        totals: {
          count: items.length,
          amount: Number(totalAmount.toFixed(2)),
          pendingCount,
          deductedCount
        },
        staffSearch: staffSearchResolution
          ? buildStaffSearchMeta(staffSearchResolution)
          : undefined
      }
    }
  }
}

async function handleSearchAccountingNotes(
  accountant: AccountantRecord,
  payload: ActionMap["SEARCH_ACCOUNTING_NOTES"]
): Promise<HandlerResponse> {
  const { query, status, projectId, unitCode, limit, includeConverted } = payload

  const resolvedLimit = parseLimit(limit, 25, 150)
  const normalizedQuery = typeof query === "string" ? query.trim() : ""

  const searchAnalysis = normalizedQuery ? analyzeExpenseSearch(normalizedQuery) : null
  const descriptionTokens = searchAnalysis?.descriptionTokens ?? []

  const whereClauses: Prisma.AccountingNoteWhereInput[] = []

  if (descriptionTokens.length > 0) {
    const descriptionFilter = buildDescriptionFilter(descriptionTokens)
    if (descriptionFilter) {
      whereClauses.push(descriptionFilter)
    }
  }

  if (normalizedQuery) {
    const searchOr: Prisma.AccountingNoteWhereInput[] = [
      {
        description: {
          contains: normalizedQuery,
          mode: "insensitive"
        } as any
      }
    ]

    if (normalizedQuery.length >= 8) {
      searchOr.push({ id: normalizedQuery })
    }

    if (normalizedQuery.length >= 6) {
      searchOr.push({ pmAdvanceId: normalizedQuery })
    }

    searchOr.push({
      unit: {
        is: {
          code: {
            contains: normalizedQuery,
            mode: "insensitive"
          } as any
        }
      }
    })

    const numericPortion = Number(normalizedQuery.replace(/[^0-9.]/g, ""))
    if (!Number.isNaN(numericPortion) && numericPortion > 0) {
      searchOr.push({ amount: numericPortion })
    }

    whereClauses.push({ OR: searchOr })
  }

  if (status && status !== "ALL") {
    whereClauses.push({ status })
  } else if (!includeConverted) {
    whereClauses.push({ status: { not: "CONVERTED" } })
  }

  if (projectId) {
    whereClauses.push({ projectId })
  }

  if (unitCode) {
    whereClauses.push({
      unit: {
        is: {
          code: {
            equals: unitCode,
            mode: "insensitive"
          } as any
        }
      }
    })
  }

  const where: Prisma.AccountingNoteWhereInput =
    whereClauses.length === 0
      ? {}
      : whereClauses.length === 1
        ? whereClauses[0]
        : { AND: whereClauses }

  const notes = await db.accountingNote.findMany({
    where,
    take: resolvedLimit,
    orderBy: {
      createdAt: "desc"
    },
    include: {
      unit: {
        select: {
          id: true,
          code: true,
          name: true,
          project: {
            select: {
              id: true,
              name: true
            }
          }
        }
      },
      project: {
        select: {
          id: true,
          name: true
        }
      },
      pmAdvance: {
        select: {
          id: true,
          amount: true,
          staff: {
            select: {
              id: true,
              name: true
            }
          }
        }
      }
    }
  })

  const items = notes.map((note) => ({
    id: note.id,
    amount: note.amount,
    status: note.status,
    description: note.description,
    unitCode: note.unit?.code ?? null,
    unitName: note.unit?.name ?? null,
    projectId: note.projectId,
    projectName: note.project?.name ?? null,
    pmAdvanceId: note.pmAdvanceId ?? null,
    pmAdvanceAmount: note.pmAdvance?.amount ?? null,
    pmAdvanceStaff: note.pmAdvance?.staff?.name ?? null,
    createdAt: note.createdAt,
    sourceType: note.sourceType
  }))

  const totalAmount = items.reduce((sum, note) => sum + (note.amount ?? 0), 0)
  const statusesBreakdown = items.reduce<Record<string, { count: number; amount: number }>>((acc, note) => {
    const key = note.status
    if (!acc[key]) {
      acc[key] = { count: 0, amount: 0 }
    }
    acc[key].count += 1
    acc[key].amount += note.amount ?? 0
    return acc
  }, {})

  return {
    status: 200,
    body: {
      success: true,
      data: {
        notes: items
      },
      humanReadable: items.length
        ? {
            en: `Found ${items.length} accounting notes totalling ${formatCurrency(totalAmount)}.`,
            ar: `تم العثور على ${items.length} قيود محاسبية بإجمالي ${formatCurrency(totalAmount)}.`
          }
        : {
            en: "No accounting notes matched the filters.",
            ar: "لا توجد قيود محاسبية مطابقة للمحددات."
          },
      meta: {
        filters: {
          status: status ?? "ALL",
          projectId: projectId ?? null,
          unitCode: unitCode ?? null,
          includeConverted: Boolean(includeConverted)
        },
        totals: {
          count: items.length,
          amount: Number(totalAmount.toFixed(2)),
          statuses: Object.fromEntries(
            Object.entries(statusesBreakdown).map(([key, value]) => [
              key,
              {
                count: value.count,
                amount: Number(value.amount.toFixed(2))
              }
            ])
          )
        },
        searchAnalysis: searchAnalysis
          ? {
              normalizedSearch: searchAnalysis.descriptionSummary,
              tokens: searchAnalysis.descriptionTokens,
              matchedSourceTypes: Array.from(searchAnalysis.matchedSourceTypes)
            }
          : null
      }
    }
  }
}

async function handlePayInvoice(
  accountant: AccountantRecord,
  payload: ActionMap["PAY_INVOICE"]
): Promise<HandlerResponse> {
  const { invoiceId, amount, action } = payload

  if (!invoiceId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Invoice id is required",
        humanReadable: {
          en: "Send the invoice id to record a payment.",
          ar: "أرسل معرف الفاتورة لتسجيل الدفع."
        }
      }
    }
  }

  const invoice = await db.invoice.findUnique({
    where: { id: invoiceId }
  })

  if (!invoice) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Invoice not found",
        humanReadable: {
          en: "I could not find an invoice with that id.",
          ar: "لم أعثر على فاتورة بهذا المعرف."
        }
      }
    }
  }

  const resolvedAction = action ?? "pay"
  const paymentAmount = resolvedAction === "mark-paid"
    ? invoice.remainingBalance
    : Number(amount)

  if (resolvedAction === "pay" && (amount === undefined || amount === null)) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Payment amount is required",
        humanReadable: {
          en: "Send how much was paid towards the invoice.",
          ar: "أرسل المبلغ المدفوع للفاتورة."
        }
      }
    }
  }

  if (Number.isNaN(paymentAmount) || paymentAmount <= 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Invalid payment amount",
        humanReadable: {
          en: "Payment amount must be a positive number.",
          ar: "المبلغ المدفوع يجب أن يكون رقماً موجباً."
        }
      }
    }
  }

  if (paymentAmount > invoice.remainingBalance) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Payment exceeds remaining balance",
        humanReadable: {
          en: "The payment is larger than the remaining balance.",
          ar: "المبلغ المدفوع أكبر من الرصيد المتبقي."
        }
      }
    }
  }

  await db.$transaction(async (tx) => {
    await tx.invoice.update({
      where: { id: invoiceId },
      data: {
        totalPaid: (invoice.totalPaid || 0) + paymentAmount,
        remainingBalance: invoice.remainingBalance - paymentAmount,
        isPaid: invoice.remainingBalance - paymentAmount <= 0
      }
    })

    await tx.payment.create({
      data: {
        invoiceId,
        amount: paymentAmount
      }
    })
  })

  const refreshed = await db.invoice.findUnique({
    where: { id: invoiceId },
    include: {
      unit: {
        include: {
          project: true
        }
      },
      ownerAssociation: {
        include: {
          contacts: {
            orderBy: { createdAt: "asc" }
          }
        }
      },
      expenses: {
        select: {
          id: true,
          description: true,
          amount: true,
          sourceType: true,
          date: true,
          createdAt: true
        }
      },
      operationalExpenses: {
        select: {
          id: true,
          description: true,
          amount: true,
          sourceType: true,
          recordedAt: true,
          createdAt: true
        }
      },
      payments: {
        select: {
          id: true,
          amount: true,
          createdAt: true
        },
        orderBy: { createdAt: "desc" }
      }
    }
  })

  return {
    status: 200,
    body: {
      success: true,
      data: normalizeInvoice(refreshed),
      message: "Invoice payment recorded",
      humanReadable: {
        en: "Invoice payment captured successfully.",
        ar: "تم تسجيل دفعة الفاتورة بنجاح."
      }
    }
  }
}

async function handleCreatePayroll(
  accountant: AccountantRecord,
  payload: ActionMap["CREATE_PAYROLL"]
): Promise<HandlerResponse> {
  const { month } = payload

  if (!month || !String(month).trim()) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Month is required",
        humanReadable: {
          en: "Send the payroll month in YYYY-MM format.",
          ar: "أرسل شهر المرتبات بصيغة YYYY-MM."
        }
      }
    }
  }

  const existing = await db.payroll.findFirst({
    where: { month }
  })

  if (existing) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Payroll already exists",
        humanReadable: {
          en: "There is already a payroll for that month.",
          ar: "يوجد كشف رواتب لهذا الشهر بالفعل."
        }
      }
    }
  }

  const staffMembers = await db.staff.findMany({
    include: {
      advances: {
        where: {
          status: "PENDING"
        }
      }
    }
  })

  if (staffMembers.length === 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "No staff members found",
        humanReadable: {
          en: "No staff members are registered to build the payroll.",
          ar: "لا يوجد موظفون مسجلون لإنشاء كشف الرواتب."
        }
      }
    }
  }

  let totalGross = 0
  let totalAdvances = 0

  const payrollItems = staffMembers.map((staff: any) => {
    const salary = staff.salary || 0
    const advancesTotal = (staff.advances || []).reduce(
      (sum: number, adv: any) => sum + adv.amount,
      0
    )
    const net = salary - advancesTotal

    totalGross += salary
    totalAdvances += advancesTotal

    return {
      staffId: staff.id,
      name: staff.name,
      salary,
      advances: advancesTotal,
      net
    }
  })

  const payroll = await db.payroll.create({
    data: {
      month,
      totalGross,
      totalAdvances,
      totalNet: totalGross - totalAdvances,
      status: "PENDING",
      createdByUserId: accountant.id,
      payrollItems: {
        create: payrollItems
      }
    },
    include: {
      payrollItems: true,
      createdByUser: {
        select: { id: true, name: true }
      }
    }
  })

  return {
    status: 201,
    body: {
      success: true,
      data: payroll,
      message: "Payroll generated",
      humanReadable: {
        en: "Payroll created and awaiting payment.",
        ar: "تم إنشاء كشف الرواتب وجاهز للدفع."
      }
    }
  }
}

async function handlePayPayroll(
  accountant: AccountantRecord,
  payload: ActionMap["PAY_PAYROLL"]
): Promise<HandlerResponse> {
  const { payrollId } = payload

  if (!payrollId) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Payroll id is required",
        humanReadable: {
          en: "Send the payroll id to mark it as paid.",
          ar: "أرسل معرف كشف الرواتب لتأكيد الدفع."
        }
      }
    }
  }

  const payroll = await db.payroll.findUnique({
    where: { id: payrollId },
    include: {
      payrollItems: true
    }
  })

  if (!payroll) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Payroll not found",
        humanReadable: {
          en: "I could not find a payroll with that id.",
          ar: "لم أعثر على كشف رواتب بهذا المعرف."
        }
      }
    }
  }

  if (payroll.status !== "PENDING") {
    return {
      status: 400,
      body: {
        success: false,
        error: "Payroll is already processed",
        humanReadable: {
          en: "This payroll was already marked as paid earlier.",
          ar: "تم دفع هذا الكشف مسبقاً."
        }
      }
    }
  }

  const staffIds = payroll.payrollItems.map((item) => item.staffId)

  const pendingAdvances = await db.staffAdvance.findMany({
    where: {
      staffId: { in: staffIds },
      status: "PENDING"
    }
  })

  for (const advance of pendingAdvances) {
    await db.staffAdvance.update({
      where: { id: advance.id },
      data: {
        status: "DEDUCTED",
        deductedFromPayrollId: payrollId
      }
    })
  }

  const updatedPayroll = await db.payroll.update({
    where: { id: payrollId },
    data: {
      status: "PAID",
      paidAt: new Date()
    },
    include: {
      payrollItems: true,
      deductedAdvances: {
        include: {
          staff: {
            select: { id: true, name: true }
          }
        }
      }
    }
  })

  return {
    status: 200,
    body: {
      success: true,
      data: updatedPayroll,
      message: "Payroll marked as paid",
      humanReadable: {
        en: "Payroll paid and pending advances deducted.",
        ar: "تم دفع كشف الرواتب وخصم السلف المعلقة."
      }
    }
  }
}

async function handleListUnitExpenses(
  accountant: AccountantRecord,
  payload: ActionMap["LIST_UNIT_EXPENSES"]
): Promise<HandlerResponse> {
  const { projectId, unitCode, limit, sourceTypes, search, fromDate, toDate } = payload

  let project: { id: string; name: string | null } | null = null

  if (projectId) {
    project = await db.project.findUnique({
      where: { id: projectId },
      select: {
        id: true,
        name: true
      }
    })

    if (!project) {
      return {
        status: 404,
        body: {
          success: false,
          error: "Project not found",
          humanReadable: {
            en: "I could not find the requested project to list its expenses.",
            ar: "لم أجد المشروع المطلوب لعرض مصروفاته."
          }
        }
      }
    }
  }

  let unit: { id: string; code: string | null; name: string | null; projectId: string } | null = null

  if (unitCode) {
    unit = await db.operationalUnit.findFirst({
      where: {
        code: unitCode,
        ...(project ? { projectId: project.id } : {})
      },
      select: {
        id: true,
        code: true,
        name: true,
        projectId: true
      }
    })

    if (!unit) {
      return {
        status: 404,
        body: {
          success: false,
          error: "Operational unit not found",
          humanReadable: {
            en: "I could not find that unit while preparing the expense list.",
            ar: "لم أجد هذه الوحدة أثناء تحضير قائمة المصروفات."
          },
          issues: {
            unitCode
          }
        }
      }
    }
  }

  const explicitSourceTypes: ExpenseSourceType[] = Array.isArray(sourceTypes)
    ? sourceTypes.filter((type: string): type is ExpenseSourceType =>
        EXPENSE_SOURCE_TYPES.includes(type as ExpenseSourceType)
      )
    : []
  const explicitSourceTypeSet = new Set(explicitSourceTypes)

  const rawSearchTerm =
    typeof search === "string" && search.trim().length > 0 ? search.trim() : null
  let cleanedSearchTerm: string | null = null
  let matchedSourceTypes = new Set<ExpenseSourceType>()
  let descriptionTokensForFilter: string[] = []
  let searchAnalysis: ReturnType<typeof analyzeExpenseSearch> | null = null

  if (rawSearchTerm) {
    searchAnalysis = analyzeExpenseSearch(rawSearchTerm)
    matchedSourceTypes = searchAnalysis.matchedSourceTypes
    descriptionTokensForFilter = searchAnalysis.descriptionTokens
    cleanedSearchTerm = searchAnalysis.descriptionSummary
  }

  let finalTypeSet: Set<ExpenseSourceType> | null =
    explicitSourceTypeSet.size > 0 ? new Set(explicitSourceTypeSet) : null

  if (matchedSourceTypes.size > 0) {
    if (finalTypeSet) {
      finalTypeSet = new Set(
        [...finalTypeSet].filter((type) => matchedSourceTypes.has(type))
      )
    } else {
      finalTypeSet = new Set(matchedSourceTypes)
    }
  }

  let fromDateValue: Date | null = null
  let toDateValue: Date | null = null

  try {
    fromDateValue = parseDateInput(fromDate, "fromDate")
    toDateValue = parseDateInput(toDate, "toDate")
  } catch (error) {
    return {
      status: 400,
      body: {
        success: false,
        error: (error as Error).message,
        humanReadable: {
          en: "The date filter is invalid. Use YYYY-MM-DD format.",
          ar: "تصفية التاريخ غير صحيحة. استخدم صيغة YYYY-MM-DD."
        }
      }
    }
  }

  if (fromDateValue && toDateValue && fromDateValue > toDateValue) {
    return {
      status: 400,
      body: {
        success: false,
        error: "fromDate must be before toDate",
        humanReadable: {
          en: "The start date must be before the end date.",
          ar: "تاريخ البداية يجب أن يكون قبل تاريخ النهاية."
        }
      }
    }
  }

  if (fromDateValue) {
    fromDateValue.setHours(0, 0, 0, 0)
  }
  if (toDateValue) {
    toDateValue.setHours(23, 59, 59, 999)
  }

  const dateFilters: Prisma.DateTimeFilter = {}
  if (fromDateValue) {
    dateFilters.gte = fromDateValue
  }
  if (toDateValue) {
    dateFilters.lte = toDateValue
  }

  const descriptionFilter =
    descriptionTokensForFilter.length > 0
      ? buildDescriptionFilter(descriptionTokensForFilter)
      : null

  const shouldSkipQuery = finalTypeSet !== null && finalTypeSet.size === 0
  const appliedSourceTypesForFilter =
    finalTypeSet && finalTypeSet.size > 0 ? Array.from(finalTypeSet) : []

  const whereClauses: Prisma.UnitExpenseWhereInput[] = []

  if (project) {
    whereClauses.push({
      unit: {
        projectId: project.id
      }
    })
  }

  if (unit) {
    whereClauses.push({ unitId: unit.id })
  }

  if (appliedSourceTypesForFilter.length > 0) {
    whereClauses.push({
      sourceType: { in: appliedSourceTypesForFilter }
    })
  }

  if (descriptionFilter) {
    whereClauses.push(descriptionFilter)
  }

  if (Object.keys(dateFilters).length > 0) {
    whereClauses.push({ date: dateFilters })
  }

  const whereClause: Prisma.UnitExpenseWhereInput | undefined =
    whereClauses.length === 0
      ? undefined
      : whereClauses.length === 1
        ? whereClauses[0]
        : { AND: whereClauses }

  const take = parseLimit(limit, 25, 100)

  const expenses = shouldSkipQuery
    ? []
    : (await db.unitExpense.findMany({
        where: whereClause,
        include: {
          unit: {
            select: {
              id: true,
              code: true,
              name: true,
              project: {
                select: {
                  id: true,
                  name: true
                }
              }
            }
          },
          recordedByUser: {
            select: {
              id: true,
              name: true,
              email: true
            }
          },
          pmAdvance: {
            select: {
              id: true,
              amount: true,
              remainingAmount: true,
              staff: {
                select: {
                  id: true,
                  name: true
                }
              }
            }
          }
        },
        orderBy: { date: "desc" },
        take
      }))

  const totalAmount = expenses.reduce((sum, expense) => sum + (expense.amount ?? 0), 0)

  const sourceBreakdown = expenses.reduce((acc, expense) => {
    const key = expense.sourceType as ExpenseSourceType
    acc[key] = acc[key] ?? { count: 0, amount: 0 }
    acc[key].count += 1
    acc[key].amount += expense.amount ?? 0
    return acc
  }, {} as Record<ExpenseSourceType, { count: number; amount: number }>)

  const projectLabel = project?.name ?? project?.id ?? "all projects"
  const unitLabel = unit?.code ?? null

  const humanReadable: HumanReadable = expenses.length
    ? {
        en: `Found ${expenses.length} unit expenses for ${projectLabel}${unitLabel ? ` (unit ${unitLabel})` : ""} totalling ${formatCurrency(totalAmount)}.`,
        ar: `تم العثور على ${expenses.length} مصروف${expenses.length === 1 ? "" : "ات"} للوحدات ضمن ${projectLabel}${unitLabel ? ` (الوحدة ${unitLabel})` : ""} بإجمالي ${formatCurrency(totalAmount)}.`
      }
    : {
        en: "No unit expenses matched the requested filters.",
        ar: "لا توجد مصروفات وحدات مطابقة للمحددات."
      }

  const suggestions: Suggestion[] = expenses.length
    ? [
        {
          title: "تحليل حسب المصدر",
          prompt: "حلل لي المصروفات دي حسب نوع المصدر وسلمني الإجمالي لكل نوع.",
          data: {
            projectId: project?.id ?? null,
            unitCode: unit?.code ?? null,
            search: rawSearchTerm
          }
        },
        {
          title: "أحدث مصروف",
          prompt: "هات تفاصيل أحدث مصروف في القائمة اللي استرجعتها.",
          data: {
            expenseId: expenses[0]?.id ?? null
          }
        }
      ]
    : [
        {
          title: "تخفيف المحددات",
          prompt: "خفف الفلاتر أو وسّع نطاق التاريخ وجرب مرة تانية.",
          data: {
            projectId: project?.id ?? null,
            unitCode,
            search: rawSearchTerm
          }
        }
      ]

  const tokenVariants = searchAnalysis
    ? Object.fromEntries(Array.from(searchAnalysis.tokenVariants.entries()))
    : {}

  return {
    status: 200,
    body: {
      success: true,
      data: {
        expenses
      },
      meta: {
        projectId: project?.id ?? null,
        projectName: project?.name ?? null,
        unitCode: unit?.code ?? null,
        count: expenses.length,
        totalAmount,
        filteredSourceTypes: appliedSourceTypesForFilter,
        requestedSourceTypes: explicitSourceTypes,
        detectedSourceTypesFromSearch: Array.from(matchedSourceTypes),
        search: rawSearchTerm,
        descriptionSearchTerm: cleanedSearchTerm,
        descriptionTokens: descriptionTokensForFilter,
        normalizedSearch: searchAnalysis?.normalizedSearch ?? null,
        tokenVariants,
        skippedQueryBecauseOfFilters: shouldSkipQuery,
        dateFilter: {
          from: formatDate(fromDateValue),
          to: formatDate(toDateValue)
        },
        breakdownBySourceType: sourceBreakdown
      },
      humanReadable,
      suggestions,
      message: expenses.length === 0 ? "لا توجد مصروفات مطابقة للمحددات الحالية" : undefined
    }
  }
}

const HANDLERS: { [K in AllowedAction]: ActionHandler<K> } = {
  CREATE_PM_ADVANCE: handleCreatePmAdvance,
  CREATE_STAFF_ADVANCE: handleCreateStaffAdvance,
  UPDATE_STAFF_ADVANCE: handleUpdateStaffAdvance,
  DELETE_STAFF_ADVANCE: handleDeleteStaffAdvance,
  RECORD_ACCOUNTING_NOTE: handleRecordAccountingNote,
  PAY_INVOICE: handlePayInvoice,
  CREATE_PAYROLL: handleCreatePayroll,
  PAY_PAYROLL: handlePayPayroll,
  LIST_UNIT_EXPENSES: handleListUnitExpenses,
  SEARCH_STAFF: handleSearchStaff,
  LIST_STAFF_ADVANCES: handleListStaffAdvances,
  SEARCH_ACCOUNTING_NOTES: handleSearchAccountingNotes
}

export async function POST(req: NextRequest) {
  const auth = await verifyN8nApiKey(req)

  if (!auth.valid) {
    const responseBody = {
      success: false,
      error: auth.error || "Unauthorized"
    }

    return NextResponse.json(responseBody, { status: 401 })
  }

  if (auth.context?.role !== "ACCOUNTANT" && auth.context?.role !== "ADMIN") {
    const responseBody = {
      success: false,
      error: "Forbidden"
    }

    await logWebhookEvent(
      auth.context?.keyId || "",
      "ACCOUNTANT_ACTION_FORBIDDEN",
      ENDPOINT,
      "POST",
      403,
      undefined,
      responseBody,
      "Forbidden accountant webhook access"
    )

    return NextResponse.json(responseBody, { status: 403 })
  }

  let parsed: RequestBody

  try {
    parsed = await req.json()
  } catch (error) {
    const responseBody = {
      success: false,
      error: "Invalid JSON payload"
    }

    await logWebhookEvent(
      auth.context.keyId,
      "ACCOUNTANT_ACTION_INVALID",
      ENDPOINT,
      "POST",
      400,
      undefined,
      responseBody,
      "Malformed JSON"
    )

    return NextResponse.json(responseBody, { status: 400 })
  }

  const { action, senderPhone, payload } = parsed

  if (!action || !senderPhone || typeof payload !== "object" || payload === null) {
    const responseBody = {
      success: false,
      error: "Missing required fields"
    }

    await logWebhookEvent(
      auth.context.keyId,
      "ACCOUNTANT_ACTION_INVALID",
      ENDPOINT,
      "POST",
      400,
      parsed,
      responseBody,
      "Missing action, senderPhone, or payload"
    )

    return NextResponse.json(responseBody, { status: 400 })
  }

  if (!ALLOWED_ACTIONS.includes(action as AllowedAction)) {
    const responseBody = {
      success: false,
      error: "Unsupported action"
    }

    await logWebhookEvent(
      auth.context.keyId,
      "ACCOUNTANT_ACTION_UNSUPPORTED",
      ENDPOINT,
      "POST",
      400,
      parsed,
      responseBody,
      `Unsupported action: ${action}`
    )

    return NextResponse.json(responseBody, { status: 400 })
  }

  const accountant = await resolveAccountant(senderPhone)

  if (!accountant) {
    const responseBody = {
      success: false,
      error: "Accountant not recognized",
      humanReadable: {
        en: "The WhatsApp number is not linked to an accountant user.",
        ar: "رقم الواتساب غير مرتبط بحساب محاسب."
      }
    }

    await logWebhookEvent(
      auth.context.keyId,
      "ACCOUNTANT_ACTION_UNAUTHORIZED",
      ENDPOINT,
      "POST",
      404,
      parsed,
      responseBody,
      "Accountant phone not resolved"
    )

    return NextResponse.json(responseBody, { status: 404 })
  }

  const handler = HANDLERS[action as AllowedAction]

  let handlerResponse: HandlerResponse

  try {
    handlerResponse = await handler(accountant, payload as any)
  } catch (error) {
    console.error(`[ACCOUNTANT_WEBHOOK][${action}]`, error)

    handlerResponse = {
      status: 500,
      body: {
        success: false,
        error: "Internal server error",
        humanReadable: {
          en: "Something went wrong while processing the accountant action.",
          ar: "حدث خطأ أثناء تنفيذ طلب المحاسب."
        }
      }
    }
  }

  const eventType = handlerResponse.body.success
    ? "ACCOUNTANT_ACTION_SUCCESS"
    : "ACCOUNTANT_ACTION_FAILED"

  await logWebhookEvent(
    auth.context.keyId,
    eventType,
    ENDPOINT,
    "POST",
    handlerResponse.status,
    parsed,
    handlerResponse.body,
    handlerResponse.body.success ? undefined : handlerResponse.body.error
  )

  return NextResponse.json(handlerResponse.body, { status: handlerResponse.status })
}
