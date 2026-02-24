"use client"

import { useEffect, useState } from "react"
import { useSession } from "next-auth/react"
import { useRouter } from "next/navigation"
import { useParams } from "next/navigation"
import { AlertCircle, Loader, MapPin, Calendar, Plus, Edit, DollarSign, Users, FileText } from "lucide-react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs"
import { Alert, AlertDescription } from "@/components/ui/alert"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table"
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog"

interface UnitData {
  id: string
  name: string
  code: string
  type: string
  isActive: boolean
  monthlyManagementFee: number | null
  monthlyBillingDay: number | null
  project: {
    id: string
    name: string
  }
}

interface Resident {
  id: string
  name: string
  email: string
  phone: string
  address: string
}

interface Ticket {
  id: string
  title: string
  status: string
  priority: string
  resident: { name: string }
  assignedTo?: { name: string }
  createdAt: string
}

interface TechWork {
  id: string
  description: string
  amount: number
  paymentStatus: string
  technician: { name: string }
  createdAt: string
}

interface AccountingNote {
  id: string
  title: string
  description: string
  amount: number
  status: string
  createdAt: string
}

interface Invoice {
  id: string
  title: string
  amount: number
  status: string
  dueDate: string
}

export default function OperationalUnitDetailPage() {
  const params = useParams()
  const router = useRouter()
  const { data: session, status } = useSession()
  const unitId = params.id as string

  const [unit, setUnit] = useState<UnitData | null>(null)
  const [residents, setResidents] = useState<Resident[]>([])
  const [tickets, setTickets] = useState<Ticket[]>([])
  const [techWork, setTechWork] = useState<TechWork[]>([])
  const [expenses, setExpenses] = useState<AccountingNote[]>([])
  const [invoices, setInvoices] = useState<Invoice[]>([])

  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)

  // States الخاصة بالتعديل
  const [isEditModalOpen, setIsEditModalOpen] = useState(false)
  const [isSaving, setIsSaving] = useState(false)
  const [editFormData, setEditFormData] = useState({
    monthlyManagementFee: 0,
    monthlyBillingDay: 1
  })

  const isPM = session?.user?.role === "PROJECT_MANAGER"
  const isAccountant = session?.user?.role === "ACCOUNTANT"
  const isAdmin = session?.user?.role === "ADMIN"

  useEffect(() => {
    if (status === "loading" || !session) return
    fetchUnitData()
  }, [session, status, unitId])

  const fetchUnitData = async () => {
    try {
      setLoading(true)
      setError(null)
      const res = await fetch(`/api/summary/unit/${unitId}`)
      if (!res.ok) throw new Error("Failed to fetch unit")
      const data = await res.json()
      setUnit(data.unit)

      // تعبئة بيانات الفورمة عند التحميل
      setEditFormData({
        monthlyManagementFee: data.unit.monthlyManagementFee || 0,
        monthlyBillingDay: data.unit.monthlyBillingDay || 1
      })

      // جلب البيانات المرتبطة
      Promise.all([
        fetch(`/api/operational-units/${unitId}/residents`).then(r => r.ok ? r.json() : []),
        fetch(`/api/tickets?unitId=${unitId}`).then(r => r.ok ? r.json() : []),
        fetch(`/api/technician-work?unitId=${unitId}`).then(r => r.ok ? r.json() : []),
        fetch(`/api/accounting-notes?unitId=${unitId}`).then(r => r.ok ? r.json() : []),
        fetch(`/api/invoices?unitId=${unitId}`).then(r => r.ok ? r.json() : []),
      ]).then(([resData, ticketData, workData, noteData, invData]) => {
        setResidents(resData)
        setTickets(ticketData)
        setTechWork(workData)
        setExpenses(noteData)
        setInvoices(invData)
      })
    } catch (err) {
      console.error("Error:", err)
      setError("Failed to load unit details")
    } finally {
      setLoading(false)
    }
  }

  const handleUpdateUnit = async () => {
    setIsSaving(true)
    try {
      const res = await fetch(`/api/operational-units/${unitId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(editFormData)
      })
      if (res.ok) {
        setIsEditModalOpen(false)
        fetchUnitData()
      }
    } catch (err) {
      console.error("Update error:", err)
    } finally {
      setIsSaving(false)
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center min-h-screen">
        <Loader className="h-8 w-8 animate-spin" />
      </div>
    )
  }

  if (error || !unit) {
    return (
      <div className="space-y-6 p-6">
        <Alert variant="destructive">
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>{error || "Unit not found"}</AlertDescription>
        </Alert>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between p-2">
        <div>
          <h1 className="text-4xl font-bold">{unit.name}</h1>
          <div className="flex items-center gap-3 mt-2 text-muted-foreground">
            <MapPin className="h-4 w-4" />
            <span>{unit.project.name}</span>
            <span>•</span>
            <span className="text-sm">{unit.code}</span>
          </div>
        </div>
        <Badge variant={unit.isActive ? "default" : "secondary"}>
          {unit.isActive ? "Active" : "Inactive"}
        </Badge>
      </div>

      {/* Quick Stats */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
              <Users className="h-4 w-4" /> Residents
            </CardTitle>
          </CardHeader>
          <CardContent><div className="text-3xl font-bold">{residents.length}</div></CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
              <AlertCircle className="h-4 w-4" /> Open Tickets
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-red-600">
              {tickets.filter(t => t.status !== "done").length}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
              <FileText className="h-4 w-4" /> Pending Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold text-yellow-600">
              {expenses.filter(e => e.status !== "recorded").length}
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm text-muted-foreground flex items-center gap-2">
              <DollarSign className="h-4 w-4" /> Total Expenses
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="text-3xl font-bold">
              ${expenses.reduce((sum, e) => sum + e.amount, 0).toFixed(2)}
            </div>
          </CardContent>
        </Card>
      </div>

      {/* Main Tabs */}
      <Tabs defaultValue="overview" className="w-full">
        <TabsList className="grid w-full grid-cols-7">
          <TabsTrigger value="overview">Overview</TabsTrigger>
          <TabsTrigger value="residents">Residents</TabsTrigger>
          <TabsTrigger value="tickets">Tickets</TabsTrigger>
          <TabsTrigger value="technician">Tech Work</TabsTrigger>
          <TabsTrigger value="expenses">Expenses</TabsTrigger>
          {(isAccountant || isAdmin) && (
            <>
              <TabsTrigger value="invoices">Invoices</TabsTrigger>
              <TabsTrigger value="payments">Payments</TabsTrigger>
            </>
          )}
        </TabsList>

        <TabsContent value="overview" className="space-y-4 pt-4">
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <Card>
              <CardHeader><CardTitle>Operations Summary</CardTitle></CardHeader>
              <CardContent className="space-y-4">
                <div className="flex justify-between items-center pb-2 border-b">
                  <span className="text-muted-foreground">Total Residents</span>
                  <span className="text-2xl font-bold">{residents.length}</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b">
                  <span className="text-muted-foreground">Tickets</span>
                  <span className="text-2xl font-bold">{tickets.length}</span>
                </div>
                <div className="flex justify-between items-center pb-2 border-b">
                  <span className="text-muted-foreground">Technician Work</span>
                  <span className="text-2xl font-bold">{techWork.length}</span>
                </div>
                {isPM && (
                  <Button onClick={() => router.push(`/dashboard/operational-units/${unitId}?tab=residents`)} className="w-full mt-4">
                    View Details
                  </Button>
                )}
              </CardContent>
            </Card>

            <Card className="border-t-4 border-t-blue-600 shadow-sm">
              <CardHeader className="flex flex-row items-center justify-between pb-2">
                <CardTitle className="text-lg font-bold">الملخص المالي</CardTitle>
                {(isAccountant || isAdmin) && (
                  <Button 
                    variant="outline" size="sm" 
                    onClick={() => setIsEditModalOpen(true)}
                    className="h-8 gap-2 text-blue-600 border-blue-200 hover:bg-blue-50"
                  >
                    <Edit className="h-3.5 w-3.5" /> تعديل البيانات
                  </Button>
                )}
              </CardHeader>
              <CardContent className="space-y-4">
                <div className="grid grid-cols-2 gap-4 p-4 rounded-xl bg-blue-50/50 border border-blue-100" dir="rtl">
                  <div className="space-y-1 text-right">
                    <span className="text-[10px] uppercase tracking-wider text-blue-600 font-bold flex items-center gap-1 justify-end">
                       مبلغ المطالبة الثابت <DollarSign className="h-3 w-3" />
                    </span>
                    <p className="text-xl font-black text-blue-900">
                      {unit.monthlyManagementFee ? unit.monthlyManagementFee.toLocaleString() : "0"} <span className="text-xs font-normal text-blue-700">ج.م</span>
                    </p>
                  </div>
                  <div className="space-y-1 text-right border-r border-blue-100 pr-4">
                    <span className="text-[10px] uppercase tracking-wider text-blue-600 font-bold flex items-center gap-1 justify-end">
                       موعد الفاتورة <Calendar className="h-3 w-3" />
                    </span>
                    <p className="text-lg font-bold text-slate-700">
                      يوم <span className="text-blue-600">{unit.monthlyBillingDay || "--"}</span>
                    </p>
                  </div>
                </div>

                <div className="space-y-3 pt-2" dir="rtl">
                  <div className="flex justify-between items-center pb-2 border-b">
                    <span className="text-muted-foreground text-sm">إجمالي المصاريف (CLM)</span>
                    <span className="font-bold text-yellow-600">
                      {expenses.reduce((sum, e) => sum + e.amount, 0).toLocaleString()} ج.م
                    </span>
                  </div>
                  <div className="flex justify-between items-center pb-2 border-b">
                    <span className="text-muted-foreground text-sm">عدد الفواتير</span>
                    <span className="font-bold">{invoices.length}</span>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-muted-foreground text-sm">مصاريف معلقة</span>
                    <span className="font-bold text-red-600">
                      {expenses.filter(e => e.status !== "recorded").length}
                    </span>
                  </div>
                </div>

                {(isAccountant || isAdmin) && (
                  <Button 
                    onClick={() => router.push(`/dashboard/operational-units/${unitId}?tab=invoices`)} 
                    className="w-full mt-4 bg-blue-600 hover:bg-blue-700"
                  >
                    عرض التفاصيل المالية
                  </Button>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Residents Tab */}
        <TabsContent value="residents" className="space-y-4 pt-4">
          <div className="flex justify-between items-center">
            <h3 className="text-lg font-semibold">Residents</h3>
            {isPM && (
              <Button onClick={() => router.push(`/dashboard/residents/new?unitId=${unitId}`)} className="gap-2" size="sm">
                <Plus className="h-4 w-4" /> Add Resident
              </Button>
            )}
          </div>
          <Card>
            <CardContent className="pt-6">
              {residents.length === 0 ? (
                <p className="text-muted-foreground text-center py-8">No residents found</p>
              ) : (
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Name</TableHead>
                      <TableHead>Phone</TableHead>
                      <TableHead>Address</TableHead>
                      {isPM && <TableHead>Actions</TableHead>}
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {residents.map((r) => (
                      <TableRow key={r.id}>
                        <TableCell className="font-medium">{r.name}</TableCell>
                        <TableCell>{r.phone || "-"}</TableCell>
                        <TableCell>{r.address || "-"}</TableCell>
                        {isPM && (
                          <TableCell>
                            <Button variant="ghost" size="sm" onClick={() => router.push(`/dashboard/residents/${r.id}/edit`)}>
                              <Edit className="h-4 w-4" />
                            </Button>
                          </TableCell>
                        )}
                      </TableRow>
                    ))}
                  </TableBody>
                </Table>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* بقية التابات (Tickets, Tech Work, etc.) محذوفة للاختصار، لكن يمكنك إضافتها بنفس النمط */}
      </Tabs>

      {/* Edit Modal */}
      <Dialog open={isEditModalOpen} onOpenChange={setIsEditModalOpen}>
        <DialogContent className="sm:max-w-[425px]" dir="rtl">
          <DialogHeader>
            <DialogTitle className="text-right">تعديل البيانات المالية</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 text-right font-sans">
            <div className="space-y-2">
              <label className="text-sm font-bold">مبلغ المطالبة الثابت (ج.م)</label>
              <Input 
                type="number" 
                value={editFormData.monthlyManagementFee}
                onChange={(e) => setEditFormData({...editFormData, monthlyManagementFee: parseFloat(e.target.value) || 0})}
              />
            </div>
            <div className="space-y-2">
              <label className="text-sm font-bold">يوم الفاتورة (شهرياً)</label>
              <Input 
                type="number" min="1" max="31"
                value={editFormData.monthlyBillingDay}
                onChange={(e) => setEditFormData({...editFormData, monthlyBillingDay: parseInt(e.target.value) || 1})}
              />
            </div>
          </div>
          <DialogFooter className="flex gap-2 justify-start flex-row-reverse">
            <Button onClick={handleUpdateUnit} disabled={isSaving}>
              {isSaving ? "جاري الحفظ..." : "حفظ"}
            </Button>
            <Button variant="outline" onClick={() => setIsEditModalOpen(false)}>إلغاء</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}