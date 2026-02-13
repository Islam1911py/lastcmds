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

type HandlerResponse = {
  status: number
  body: Record<string, unknown>
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
      body: { error: "Missing or invalid fields for operational expense" }
    }
  }

  if (sourceType !== "OFFICE_FUND" && sourceType !== "PM_ADVANCE") {
    return {
      status: 400,
      body: { error: "Invalid sourceType. Use OFFICE_FUND or PM_ADVANCE" }
    }
  }

  const project = await db.project.findUnique({ where: { id: projectId } })

  if (!project) {
    return {
      status: 404,
      body: { error: "Project not found" }
    }
  }

  if (!assertProjectAccess(manager, projectId)) {
    return {
      status: 403,
      body: { error: "Project manager is not assigned to this project" }
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
      body: { error: "Operational unit not found for provided code" }
    }
  }

  let connectedPmAdvanceId: string | null = null
  let pmAdvanceRemaining: number | undefined

  if (sourceType === "PM_ADVANCE") {
    if (!pmAdvanceId) {
      return {
        status: 400,
        body: { error: "pmAdvanceId is required for PM_ADVANCE source" }
      }
    }

    const pmAdvance = await db.pMAdvance.findUnique({
      where: { id: pmAdvanceId }
    })

    if (!pmAdvance) {
      return {
        status: 404,
        body: { error: "PM advance not found" }
      }
    }

    if (pmAdvance.projectId && pmAdvance.projectId !== projectId) {
      return {
        status: 403,
        body: { error: "PM advance does not belong to the provided project" }
      }
    }

    if (pmAdvance.remainingAmount < numericAmount) {
      return {
        status: 400,
        body: { error: "Insufficient PM advance remaining balance" }
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
        body: { error: "Invalid recordedAt value" }
      }
    }
    recordedAtDate = parsed
  }

  const expense = await db.operationalExpense.create({
    data: {
      unitId: unit.id,
      description: normalizedDescription,
      amount: numericAmount,
      sourceType,
      pmAdvanceId: sourceType === "PM_ADVANCE" ? connectedPmAdvanceId : null,
      recordedByUserId: manager.id,
      recordedAt: recordedAtDate
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
      }
    }
  })

  if (connectedPmAdvanceId) {
    await db.pMAdvance.update({
      where: { id: connectedPmAdvanceId },
      data: {
        remainingAmount: {
          decrement: numericAmount
        }
      }
    })
  }

  return {
    status: 201,
    body: {
      success: true,
      message: "Operational expense recorded",
      expense: {
        id: expense.id,
        description: expense.description,
        amount: expense.amount,
        sourceType: expense.sourceType,
        unit: expense.unit,
        recordedAt: expense.recordedAt,
        recordedByUserId: expense.recordedByUserId,
        pmAdvanceRemaining
      }
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
      body: { error: "projectId and unitCode are required" }
    }
  }

  if (!assertProjectAccess(manager, projectId)) {
    return {
      status: 403,
      body: { error: "Project manager is not assigned to this project" }
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
      body: { error: "Operational unit not found" }
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

  return {
    status: 200,
    body: {
      success: true,
      residents,
      count: residents.length
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
      body: { error: "projectId is required" }
    }
  }

  if (!assertProjectAccess(manager, projectId)) {
    return {
      status: 403,
      body: { error: "Project manager is not assigned to this project" }
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

  return {
    status: 200,
    body: {
      success: true,
      tickets,
      count: tickets.length
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
      body: { error: "Internal server error" }
    }
  }

  const enrichedBody = {
    ...response.body,
    manager: managerContext
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
