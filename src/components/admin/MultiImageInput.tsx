'use client'

import { useRef, useState } from 'react'
import { X, Plus, ImagePlus } from 'lucide-react'
import styles from './admin.module.css'

interface MultiImageInputProps {
  images: string[]
  onChange: (images: string[]) => void
  multiple?: boolean
  label?: string
}

export default function MultiImageInput({
  images,
  onChange,
  multiple = true,
  label = 'تصاویر محصول',
}: MultiImageInputProps) {
  const [urlValue, setUrlValue] = useState('')
  const [uploading, setUploading] = useState(false)
  const [error, setError] = useState('')
  const fileRef = useRef<HTMLInputElement>(null)

  const uploadFiles = async (files: FileList) => {
    setError('')
    setUploading(true)

    const uploaded: string[] = []
    try {
      for (const file of Array.from(files)) {
        const fd = new FormData()
        fd.append('file', file)
        const res = await fetch('/api/upload', { method: 'POST', body: fd })
        const data = await res.json()
        if (res.ok) {
          uploaded.push(data.url)
        } else {
          setError(data.error || 'خطا در آپلود یکی از فایلها')
        }
      }
      if (uploaded.length > 0) {
        onChange(multiple ? [...images, ...uploaded] : [uploaded[0]])
      }
    } catch {
      setError('خطای ارتباط با سرور در آپلود')
    } finally {
      setUploading(false)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  const addUrl = () => {
    const url = urlValue.trim()
    if (!url) return
    onChange(multiple ? [...images, url] : [url])
    setUrlValue('')
  }

  const removeAt = (idx: number) => {
    onChange(images.filter((_, i) => i !== idx))
  }

  return (
    <div className={styles.uploader}>
      <label>{label}</label>

      {/* Thumbnails */}
      {images.length > 0 && (
        <div className={styles.thumbnails}>
          {images.map((img, i) => (
            <div
              key={`${img}-${i}`}
              className={styles.thumbnail}
            >
              <img src={img} alt={`تصویر ${i + 1}`} className="w-full h-full object-cover" />
              {i === 0 && multiple && (
                <span className="absolute bottom-0 inset-x-0 bg-night/70 text-white text-[10px] text-center py-0.5">
                  اصلی
                </span>
              )}
              <button
                type="button"
                onClick={() => removeAt(i)}
                aria-label="حذف تصویر"
                className="absolute top-1 left-1 bg-red-500 hover:bg-red-600 text-white rounded-full p-0.5 opacity-90 transition-opacity"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Upload button */}
      <div className={styles.uploadControls}>
      <label
        className={`${styles.uploadButton} ${
          uploading ? 'opacity-50 pointer-events-none' : ''
        }`}
      >
        <ImagePlus className="w-4 h-4" />
        {uploading ? 'در حال آپلود...' : 'انتخاب فایل از سیستم'}
        <input
          ref={fileRef}
          type="file"
          accept="image/jpeg,image/png,image/webp,image/gif"
          {...(multiple ? { multiple: true } : {})}
          className="sr-only"
          onChange={(e) => e.target.files && uploadFiles(e.target.files)}
          disabled={uploading}
        />
      </label>
      <span className="text-xs text-mist">یا</span>

      {/* URL input */}
      <div className={styles.urlInput}>
        <input
          className="input-field"
          dir="ltr"
          placeholder="https://..."
          aria-label="آدرس اینترنتی تصویر"
          value={urlValue}
          onChange={(e) => setUrlValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault()
              addUrl()
            }
          }}
        />
        <button
          type="button"
          onClick={addUrl}
          disabled={!urlValue.trim()}
          aria-label="افزودن تصویر"
          className="transition-colors disabled:opacity-30"
        >
          <Plus className="w-4 h-4" />
        </button>
      </div>
      </div>

      <p className="text-xs text-mist mt-2">
        JPG، PNG، WebP یا GIF — هر فایل حداکثر ۵ مگابایت{multiple ? ' — اولین تصویر، اصلی است' : ''}
      </p>

      {error && <p className="text-xs text-red-600 mt-1">{error}</p>}
    </div>
  )
}
