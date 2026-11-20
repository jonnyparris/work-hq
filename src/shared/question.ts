// Is a typed note a question? A question in the item drawer wants an answer, so it goes to the note reader
// instead of being kept as context. 11-06 13:41: "I've got the Zinc bot credentials… What do i do with it next?"
// was filed as context and the usage digest called it "kept as context", so nobody answered it.
// Dependency-free: shared by the server (hub.isInstruction) and the usage digest.

/** "context:", "fyi", "note:", "bg:" openers: background whatever follows, questions included. */
export function isBackground(text: string): boolean {
  return /^(context|fyi|note|bg|background|for context|nb)\b\s*[:\-—,]?/i.test(text.trim());
}

/** Ends in "?", allowing closing quotes, brackets or extra marks after it: "…next?", "(wiki link?)", "really?!". */
const TRAILING_Q = /\?[\s"'”’)\]!?.…]*$/;

/** Opens like a question without the "?": "what's the status", "why hasn't this moved", "should we drop it".
 *  A wh-word only counts with an auxiliary (or a negated verb) after it, so "When Kevin's back he owns this",
 *  "How we fixed it: …" and "Why we chose X: …" stay background. */
const WH = /^(what|why|how|when|where|who|which)('s|\s+(is|are|was|were|do|does|did|should|shall|can|could|would|will|has|have|had)\b|\s+\w+n't\b)/i;
/** Auxiliary + subject. "do" only with a person, so "Do it" / "Do this" stay imperatives, not questions. */
const AUX = /^((should|shall|can|could|would|will|is|are|was|were|does|did|has|have)\s+(i|we|you|he|she|they|it|this|that|these|those|there|anyone|someone|somebody)|do\s+(i|we|you|they|anyone|someone|somebody))\b/i;

export function isQuestion(text: string): boolean {
  const t = text.trim();
  return TRAILING_Q.test(t) || WH.test(t) || AUX.test(t);
}
