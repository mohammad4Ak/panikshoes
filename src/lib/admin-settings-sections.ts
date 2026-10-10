export const settingsSections = [
  { id: 'branding', label: 'برندینگ و لوگو', description: 'نام فروشگاه و نشان تجاری' },
  { id: 'appearance', label: 'رنگ‌بندی', description: 'رنگ‌بندی فروشگاه و پنل مدیریت' },
  { id: 'homepage', label: 'صفحهٔ اول', description: 'محصولات چرخشی، زمان تعویض و بنر' },
  { id: 'announcement', label: 'اطلاعیه', description: 'پیام عمومی بالای سایت' },
  { id: 'contact', label: 'اطلاعات تماس', description: 'تلفن، نشانی و راه‌های ارتباطی' },
  { id: 'seo', label: 'عنوان و توضیحات سایت', description: 'عنوان و معرفی سایت در جست‌وجو' },
] as const

export type SettingsSectionId = (typeof settingsSections)[number]['id']

export function isSettingsSection(value: string): value is SettingsSectionId {
  return settingsSections.some((section) => section.id === value)
}

export function getSettingsSection(hash: string): SettingsSectionId {
  const value = hash.replace(/^#/, '')
  return isSettingsSection(value) ? value : 'branding'
}
