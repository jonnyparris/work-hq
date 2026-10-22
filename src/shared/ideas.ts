// How many idea items an action agent may file, and when the owner asked for more.
/** New idea items one action job may file. More go into its summary as a "Could also:" line. */
export const IDEA_CAP = 2;

/** The dispatch note asked for ideas ("file ideas", "suggest 3 items"), so the cap doesn't apply. */
export function asksForIdeas(note?: string): boolean {
  return Boolean(note && /\b(file|suggest|propose)\b[^.]{0,30}\b(ideas?|items|improvements)\b|\bbrainstorm/i.test(note));
}
