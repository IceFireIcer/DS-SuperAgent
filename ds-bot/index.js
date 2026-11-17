import { installProduct } from './src/host/product.js'

export const name = 'ds-bot'
export const inject = ['connection']

/** The package now contains only the DS-SuperAgent product host surface. */
export function apply(ctx) {
  return installProduct(ctx)
}
