# AI Agent Role-Specific Webhook Guide

This guide enumerates the webhooks available to the AI agent for the three core roles—Project Manager, Accountant, and Admin—and explains how to call each endpoint safely.

---

## 🔐 Shared Requirements
- **Header:** `X-API-KEY` with the n8n key issued for the target role.
- **Base URL:** Same domain hosting the Next.js app, e.g. `https://your-domain.com`.
- **Response Format:** Every route returns JSON with `success`, `humanReadable`, `suggestions`, and `meta` where relevant.
- **Logging:** All calls are captured via `logWebhookEvent`, so include contextual fields to simplify debugging.

---

## 👷 Project Manager Webhooks

### 1. POST `/api/webhooks/project-managers`
Central dispatcher driven by the `action` field. Requires the manager's WhatsApp phone in `senderPhone` to validate permissions.

| Action | Purpose | Required Payload Fields | Optional Fields |
|--------|---------|-------------------------|-----------------|
| `LIST_PROJECT_TICKETS` | Fetch latest tickets for a project/unit | `projectId` | `unitCode`, `statuses[]` (`NEW`, `IN_PROGRESS`, `DONE`), `limit` (default 5) |
| `CREATE_OPERATIONAL_EXPENSE` | Record an operational expense | `projectId`, `unitCode`, `description`, `amount`, `sourceType` (`OFFICE_FUND` or `PM_ADVANCE`) | `pmAdvanceId` (when `sourceType=PM_ADVANCE`), `recordedAt` (ISO date) |
| `GET_RESIDENT_PHONE` | Lookup residents for outreach | `projectId`, `unitCode` | `residentName`, `limit` (default 5) |

**Generic Body Template**
```json
{
  "action": "LIST_PROJECT_TICKETS",
  "senderPhone": "+966500000000",
  "payload": {
    "projectId": "prj_123",
    "limit": 5
  }
}
```

**Response Highlights**
- `data` contains the action result (tickets, expense record, or residents list).
- `meta` surfaces counts, unit codes, remaining advance balance, etc.
- `humanReadable` delivers bilingual summaries for quick agent narration.
- `suggestions` proposes follow-up prompts (e.g. “اعرض جميع السكان”).

### 2. GET `/api/webhooks/query?type=LAST_EXPENSE`
Shortcut for summarising recent expenses. Designed for quick insights after the interpreter suggests it.

| Query Parameter | Notes |
|-----------------|-------|
| `type=LAST_EXPENSE` | Required discriminator. |
| `projectId` | Required unless the API key is project-scoped. |
| `range` | Optional (`TODAY`, `WEEK`, `MONTH`, `ALL`). |
| `senderPhone` | Optional but unlocks auto-permission checks. |

Returns a list of expenses sorted by recency plus totals in `meta.totalAmount` (if available).

### 3. GET `/api/webhooks/tickets`
Direct listing endpoint when the agent already knows exact filters (mirrors the action above but without `senderPhone`).

| Query Parameter | Notes |
|-----------------|-------|
| `projectId` | Mandatory. |
| `status` | Optional (`NEW`, `IN_PROGRESS`, `DONE`). |
| `limit` | Optional (default 10, max 50). |

Use when operating with service credentials instead of impersonating a manager phone.

---

## 📊 Accountant Webhooks

### 1. GET `/api/webhooks/query?type=ACCOUNTING_DATA`
Aggregates invoices, payments, pending amounts, and accounting notes for finance reviews.

| Query Parameter | Notes |
|-----------------|-------|
| `type=ACCOUNTING_DATA` | Required. |
| `projectId` | Optional; defaults to all visible projects for the accountant key. |
| `senderPhone` | Optional for personalized scoping/logging. |

**Response Sections**
- `data.invoices`: each with `amount`, `paid`, `balance`, status labels.
- `data.payments`: chronological ledger with invoice/technician references.
- `data.pendingNotes`: outstanding accounting notes requiring action.

### 2. POST `/api/webhooks/accounting-notes`
Creates a new accounting note (typically triggered by a project manager or admin, but accountants can consume the output).

**Body Fields**
| Field | Required | Description |
|-------|----------|-------------|
| `unitId` | ✅ | Target operational unit UUID. |
| `description` | ✅ | Core note text (multi-line allowed). |
| `amount` | ✅ | Positive numeric value. |
| `reason` | ❌ | Extra clarification appended to `description`. |
| `notes` | ❌ | Additional context appended to `description`. |
| `createdByUserId` | ❌ | Force ownership to specific user (fallback auto-resolved). |
| `pmPhone` | ❌ | Helps auto-identify the project manager creating the note. |

Successful responses include:
- `unit` object with project name, code, and display label.
- `whatsappMessage`: ready-to-forward Arabic summary for finance chat.
- `humanReadable`: bilingual recap referencing project, unit, and value.

### 3. GET `/api/webhooks/accounting-note`
Fetches a single note by ID for reconciliation.

| Query Parameter | Notes |
|-----------------|-------|
| `noteId` | Required note UUID. |

Returns the stored note data plus related unit and creator info.

---

## 🗂️ Admin Webhooks

### 1. GET `/api/webhooks/query?type=ALL_DATA`
Full operational snapshot suitable for leadership dashboards.

| Query Parameter | Notes |
|-----------------|-------|
| `type=ALL_DATA` | Required. |
| `projectId` | Optional filter to narrow scope. |
| `senderPhone` | Optional; if provided, ensures the admin phone is authorised. |

`data` contains sections for projects, units, residents, tickets, invoices, payments, and expenses, each already summarised with totals.

### 2. GET `/api/webhooks/delivery-orders`
Lists recent delivery orders across projects for operations oversight.

| Query Parameter | Notes |
|-----------------|-------|
| `projectId` | Optional. |
| `status` | Optional status filter. |
| `limit` | Optional (default 10). |

### 3. GET `/api/webhooks/tickets`
Same endpoint as the manager view, but admin keys can access every project without additional `senderPhone` scoping.

---

## 🧠 Working with the Interpreter
For natural language conversion, call [`/api/webhooks/query/interpret`](AI_AGENT_NL_INTERPRETER.md) first. It will:
1. Detect intent (tickets, expenses, accounting, admin summary).
2. Return ranked candidates with the appropriate endpoint/method.
3. List `requiredParameters` and `optionalParameters` so the agent can fill placeholders before executing the real webhook.

---

## ✅ Quick Checklist for Workflow Authors
- [ ] Identify user role and pick the correct API key.
- [ ] Call the interpreter (optional but recommended) and choose the top candidate.
- [ ] Supply all `requiredParameters` in the payload or query string.
- [ ] Execute the webhook and parse `data`, `meta`, `humanReadable`.
- [ ] Use `suggestions` to craft follow-up prompts if the answer is incomplete.
- [ ] Log or surface `meta` totals to the user for better transparency.

Keeping these patterns consistent ensures the AI agent serves managers, accountants, and admins with minimal custom logic.
