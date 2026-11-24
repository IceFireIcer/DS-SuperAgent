import { createElement as h } from 'react'
import { ProductLogo } from './product-logo.js'

export function ProductBrandMark({ size = 24 }) {
  return h(ProductLogo, { size })
}
