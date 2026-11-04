import { z } from 'zod';

const MAX_NAME = 120;
const MAX_SELECTED_OPTIONS = 100;

/** Modifier option ids selected on one order line (same bounds as Sprint Serve). */
export const selectedOptions = () =>
  z.array(z.string().min(1).max(MAX_NAME)).max(MAX_SELECTED_OPTIONS);
