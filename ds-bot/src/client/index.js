import { applyProduct } from './product.js'

export const inject = ['sessions', 'uiWorkspace', 'uiConversation', 'slots', 'theme', 'layout']

export function apply(ctx) {
  return applyProduct(ctx)
}
