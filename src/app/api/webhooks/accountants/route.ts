import { NextRequest, NextResponse } from "next/server"

import { db } from "@/lib/db"
import { verifyN8nApiKey, logWebhookEvent } from "@/lib/n8n-auth"
import { buildPhoneVariants } from "@/lib/phone"

const ENDPOINT = "/api/webhooks/accountants"

const ALLOWED_ACTIONS = [
  "CREATE_PM_ADVANCE",
  "CREATE_STAFF_ADVANCE",
  "UPDATE_STAFF_ADVANCE",
  "DELETE_STAFF_ADVANCE",
  "RECORD_ACCOUNTING_NOTE",
  "PAY_INVOICE",
  "CREATE_PAYROLL",
  "PAY_PAYROLL"
] as const

type AllowedAction = (typeof ALLOWED_ACTIONS)[number]

type ActionMap = {
  CREATE_PM_ADVANCE: {
    staffId: string
    amount: number | string
    projectId?: string | null
    notes?: string | null
  }
  CREATE_STAFF_ADVANCE: {
    staffId: string
    amount: number | string
    note?: string | null
  }
  UPDATE_STAFF_ADVANCE: {
    advanceId: string
    amount?: number | string | null
    note?: string | null
  }
  DELETE_STAFF_ADVANCE: {
    advanceId: string
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
}

type ActionErrorPayload = {
  success: false
  error: string
  issues?: Record<string, unknown>
  humanReadable?: HumanReadable
  suggestions?: Suggestion[]
}

type HandlerResponse = {
  status: number
  body: ActionSuccessPayload | ActionErrorPayload
}

type ActionHandler<K extends AllowedAction> = (
  accountant: AccountantRecord,
  payload: ActionMap[K]
) => Promise<HandlerResponse>

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
  const { staffId, amount, projectId, notes } = payload
  const numericAmount = Number(amount)

  if (!staffId || Number.isNaN(numericAmount) || numericAmount <= 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Missing or invalid fields for PM advance",
        humanReadable: {
          en: "Please send staff id with a positive amount to create the PM advance.",
          ar: "من فضلك أرسل رقم الموظف مع قيمة موجبة لتسجيل العهدة."
        }
      }
    }
  }

  const staff = await db.staff.findUnique({
    where: { id: staffId },
    select: { id: true, name: true }
  })

  if (!staff) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Staff member not found",
        humanReadable: {
          en: "I could not find a staff member with that identifier.",
          ar: "لم أعثر على موظف بهذا المعرف."
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
      staffId,
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
      }
    }
  }
}

async function handleCreateStaffAdvance(
  accountant: AccountantRecord,
  payload: ActionMap["CREATE_STAFF_ADVANCE"]
): Promise<HandlerResponse> {
  const { staffId, amount, note } = payload
  const numericAmount = Number(amount)

  if (!staffId || Number.isNaN(numericAmount) || numericAmount <= 0) {
    return {
      status: 400,
      body: {
        success: false,
        error: "Missing or invalid fields for staff advance",
        humanReadable: {
          en: "Staff id and a positive amount are required to create a staff advance.",
          ar: "رقم الموظف وقيمة موجبة مطلوبان لتسجيل سلفة موظف."
        }
      }
    }
  }

  const staff = await db.staff.findUnique({
    where: { id: staffId },
    select: { id: true, name: true }
  })

  if (!staff) {
    return {
      status: 404,
      body: {
        success: false,
        error: "Staff member not found",
        humanReadable: {
          en: "I could not find a staff member with that identifier.",
          ar: "لم أعثر على موظف بهذا المعرف."
        }
      }
    }
  }

  const advance = await db.staffAdvance.create({
    data: {
      staffId,
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

  return {
    status: 201,
    body: {
      success: true,
      data: advance,
      message: "Staff advance created",
      humanReadable: {
        en: `Staff advance of ${formatCurrency(advance.amount)} recorded successfully.`,
        ar: `تم تسجيل سلفة بقيمة ${formatCurrency(advance.amount)} بنجاح.`
      }
    }
  }
}

async function handleUpdateStaffAdvance(
  accountant: AccountantRecord,
  payload: ActionMap["UPDATE_STAFF_ADVANCE"]
): Promise<HandlerResponse> {
  const { advanceId, amount, note } = payload

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
        }
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

  const updateData: Record<string, unknown> = {}

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
          }
        }
      }
    }

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

  return {
    status: 200,
    body: {
      success: true,
      data: updatedAdvance,
      message: "Staff advance updated",
      humanReadable: {
        en: "Staff advance updated successfully.",
        ar: "تم تعديل السلفة بنجاح."
      }
    }
  }
}

async function handleDeleteStaffAdvance(
  accountant: AccountantRecord,
  payload: ActionMap["DELETE_STAFF_ADVANCE"]
): Promise<HandlerResponse> {
  const { advanceId } = payload

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
        }
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
        }
      }
    }
  }

  await db.staffAdvance.delete({
    where: { id: advanceId }
  })

  return {
    status: 200,
    body: {
      success: true,
      data: { advanceId },
      message: "Staff advance deleted",
      humanReadable: {
        en: "Staff advance deleted successfully.",
        ar: "تم حذف السلفة بنجاح."
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

const HANDLERS: { [K in AllowedAction]: ActionHandler<K> } = {
  CREATE_PM_ADVANCE: handleCreatePmAdvance,
  CREATE_STAFF_ADVANCE: handleCreateStaffAdvance,
  UPDATE_STAFF_ADVANCE: handleUpdateStaffAdvance,
  DELETE_STAFF_ADVANCE: handleDeleteStaffAdvance,
  RECORD_ACCOUNTING_NOTE: handleRecordAccountingNote,
  PAY_INVOICE: handlePayInvoice,
  CREATE_PAYROLL: handleCreatePayroll,
  PAY_PAYROLL: handlePayPayroll
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
