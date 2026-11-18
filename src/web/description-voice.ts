/**
 * Voice hints for a curated waypoint description, shared by the two pages that
 * edit one: the local waypoint editor (`admin-waypoints.ts`, dev server only)
 * and the live description editor on the deployed site
 * (`admin-descriptions.ts`). It stands alone so that the deployed page's
 * bundle takes in nothing of the local editor's view module.
 */

export interface VoiceHint {
  /** The words that tripped it, as written. */
  match: string;
  message: string;
}

/**
 * Soft checks against the house voice (`scripts/lib/waypoint-descriptions.ts`):
 * descriptions state what is there and never instruct the walker or address
 * them as "you". Hints only; nothing is blocked.
 */
export function voiceHints(text: string): VoiceHint[] {
  const hints: VoiceHint[] = [];
  const seen = new Set<string>();
  const add = (match: string, message: string) => {
    const key = `${match.toLowerCase()}|${message}`;
    if (seen.has(key)) return;
    seen.add(key);
    hints.push({ match, message });
  };
  for (const m of text.matchAll(/\b(you|your|you're|you'll|yourself|yours)\b/gi)) {
    add(m[0], 'Addresses the walker: describe the place instead.');
  }
  for (const m of text.matchAll(/\b(should|must|need to|needs to|be sure|make sure|recommended?|advisable)\b/gi)) {
    add(m[0], 'Tells the walker what to do: say what is there and let them decide.');
  }
  const imperative =
    /(?:^|[.!?]\s+)(Treat|Fill|Carry|Check|Bring|Ensure|Avoid|Remember|Plan|Consider|Allow|Expect|Take|Don't|Do not|Beware|Stock up|Top up|Head)\b/g;
  for (const m of text.matchAll(imperative)) {
    add(m[1], 'Starts an instruction: describe the facility or the water instead.');
  }
  if (/\s{2,}/.test(text.trim())) add('double space', 'Has a double space or a blank line.');
  if (text.trim() && !/[.!?)"”]$/.test(text.trim())) add('ending', 'Does not end with a full stop.');
  return hints;
}
