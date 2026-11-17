import { t } from './i18n.js'

/** Center-crop a role image to a small square before it becomes preset appearance data. */
export async function productAvatarImage(file) {
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.type)) throw new Error(t('Choose a PNG, JPEG, WebP, or GIF image'))
  if (file.size > 25 * 1024 * 1024) throw new Error(t('Choose an image smaller than 25 MB'))
  const bitmap = await createImageBitmap(file)
  const side = 160
  const canvas = document.createElement('canvas')
  canvas.width = side
  canvas.height = side
  const context = canvas.getContext('2d')
  context.imageSmoothingQuality = 'high'
  const crop = Math.min(bitmap.width, bitmap.height)
  context.drawImage(bitmap, (bitmap.width - crop) / 2, (bitmap.height - crop) / 2, crop, crop, 0, 0, side, side)
  bitmap.close?.()
  for (const quality of [0.9, 0.75, 0.6]) {
    const url = canvas.toDataURL('image/webp', quality)
    if (url.startsWith('data:image/webp') && url.length < 150000) return url
  }
  const png = canvas.toDataURL('image/png')
  if (png.length < 150000) return png
  throw new Error(t('That image is too large'))
}
