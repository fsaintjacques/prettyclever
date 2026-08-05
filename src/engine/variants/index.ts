import type { VariantDef } from '../types';
import { standard } from './standard';

export const variants: Record<string, VariantDef> = {
  standard,
};

export function getVariant(id: string): VariantDef {
  const v = variants[id];
  if (!v) throw new Error(`unknown variant: ${id}`);
  return v;
}

export { standard };
