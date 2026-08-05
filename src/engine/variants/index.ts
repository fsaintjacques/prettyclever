import type { VariantDef } from '../types';
import { thatsPrettyClever } from './thats-pretty-clever';

export const variants: Record<string, VariantDef> = {
  [thatsPrettyClever.id]: thatsPrettyClever,
};

export function getVariant(id: string): VariantDef {
  const v = variants[id];
  if (!v) throw new Error(`unknown variant: ${id}`);
  return v;
}

export { thatsPrettyClever };
