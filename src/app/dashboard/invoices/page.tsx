"use client"

import { useEffect, useState } from "react"
// ... (باقي الـ imports اللي عندك)

export default function InvoicesPage() {
  // ... (الـ states القديمة)

  // ضيف الـ state دي عشان نحدد نوع الفاتورة اللي هنصدرها
  const [genType, setGenType] = useState<"MANAGEMENT" | "EXPENSES">("MANAGEMENT")

  const handleGenerateInvoices = async () => {
    if (!selectedProjectId) {
      alert("يا أستاذ، لازم تختار المشروع الأول")
      return
    }

    try {
      setGenerating(true)
      // بنبعت النوع للسيرفر عشان يعرف يلم (رسوم إدارة) ولا (مصاريف CLM)
      const response = await fetch("/api/invoices/generate-project-invoice", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          projectId: selectedProjectId,
          type: genType, // النوع اللي اخترناه
          customDay: parseInt(genDay)
        })
      })

      if (response.ok) {
        alert(`تم بنجاح إصدار فاتورة ${genType === 'MANAGEMENT' ? 'الإدارة' : 'المصاريف'} للمشروع.`)
        setShowGenerateDialog(false)
        fetchInvoices()
      } else {
        alert("فشل إصدار الفاتورة")
      }
    } catch (error) {
      console.error(error)
      alert("حدث خطأ")
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="space-y-6">
      {/* ... الـ Header و الـ Summary Cards ... */}

      {/* التعديل في الـ Dialog بتاع الإصدار */}
      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>إصدار فاتورة مشروع</DialogTitle>
          </DialogHeader>
          <div className="grid gap-4 py-4 text-right">
            
            <div className="space-y-2">
              <Label>نوع الفاتورة</Label>
              <select 
                className="flex h-10 w-full rounded-md border border-input bg-background px-3"
                value={genType}
                onChange={(e) => setGenType(e.target.value as any)}
              >
                <option value="MANAGEMENT">فاتورة رسوم إدارة (ثابتة)</option>
                <option value="EXPENSES">فاتورة مصاريف ونفقات (CLM)</option>
              </select>
            </div>

            <div className="space-y-2">
              <Label>المشروع</Label>
              <select 
                className="flex h-10 w-full rounded-md border border-input bg-background px-3"
                value={selectedProjectId}
                onChange={(e) => setSelectedProjectId(e.target.value)}
              >
                <option value="">-- اختر المشروع --</option>
                {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
              </select>
            </div>
            
            <p className="text-xs text-muted-foreground bg-orange-50 p-2 rounded">
              {genType === 'EXPENSES' 
                ? "ملاحظة: سيتم تجميع كل مصاريف الوحدات (CLM) التي لم تُدفع بعد في فاتورة واحدة للمشروع."
                : "ملاحظة: سيتم حساب رسوم الإدارة الشهرية لكل وحدات المشروع."}
            </p>
          </div>
          <DialogFooter>
            <Button onClick={handleGenerateInvoices} disabled={generating} className="bg-blue-600">
              {generating ? "جاري الإصدار..." : "إصدار الفاتورة الآن"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* الجدول هيعرض الفواتير سواء كانت MANAGEMENT أو EXPENSES */}
    </div>
  )
}