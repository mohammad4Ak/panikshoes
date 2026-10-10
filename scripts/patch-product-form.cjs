const { readFileSync, writeFileSync } = require('fs')

const f = 'src/app/admin/products/page.tsx'
let s = readFileSync(f, 'utf8')

// 1) import MultiImageInput بعد از lucide import
s = s.replace(
  "import { Plus, Pencil, Trash2, Eye, X } from 'lucide-react'",
  "import { Plus, Pencil, Trash2, Eye, X } from 'lucide-react'\nimport MultiImageInput from '@/components/admin/MultiImageInput'"
)

// 2) emptyForm: image -> images array
s = s.replace("  image: '',", "  images: [] as string[],")

// 3) حذف state uploading
s = s.replace("  const [uploading, setUploading] = useState(false)\r\n", '')
s = s.replace("  const [uploading, setUploading] = useState(false)\n", '')

// 4) حذف handleFileChange کامل (تابع تا بسته شدنش)
const fnStart = s.indexOf('  const handleFileChange')
if (fnStart !== -1) {
  const fnEnd = s.indexOf('\n  }\n', fnStart)
  if (fnEnd !== -1) {
    s = s.slice(0, fnStart) + s.slice(fnEnd + 5)
  }
}

// 5) openEditModal prefill
s = s.replace("      image: product.images[0] || '',", '      images: product.images,')

// 6) payload
s = s.replace('      images: form.image ? [form.image] : [],', '      images: form.images,')

// 7) جایگزینی کل بلوک فیلد تصویر با MultiImageInput
const blockStart = s.indexOf('              <div>\r\n                <label className="block font-bold mb-2">تصویر محصول</label>')
const altStart = s.indexOf('              <div>\n                <label className="block font-bold mb-2">تصویر محصول</label>')
const start = blockStart !== -1 ? blockStart : altStart

if (start !== -1) {
  // پیدا کردن پایان بلوک: آخرین </div> قبل از checkbox label
  const checkboxIdx = s.indexOf('<label className="flex items-center gap-3 cursor-pointer">', start)
  const sectionEnd = s.lastIndexOf('</div>', checkboxIdx)
  const afterDiv = s.indexOf('>', sectionEnd) + 1
  s =
    s.slice(0, start) +
    '              <MultiImageInput\n' +
    '                images={form.images}\n' +
    '                onChange={(imgs) => setForm((f) => ({ ...f, images: imgs }))}\n' +
    '              />\n' +
    s.slice(afterDiv)
} else {
  console.log('WARN: image field block not found!')
}

writeFileSync(f, s)
console.log('done - product form now uses MultiImageInput')
