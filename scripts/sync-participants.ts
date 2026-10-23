// Fetches participant labels from safe-fndn/safenet-data at a commit (default: the latest commit
// on main), writes dune/data/participants.json and regenerates the safenet_participant_labels SQL.
//
//   node scripts/sync-participants.ts [--ref <commit>]

import { writeFile } from "node:fs/promises";
import { parseArgs } from "node:util";
import {
  LABELS_SQL_PATH,
  normalize,
  PARTICIPANT_FILES,
  PARTICIPANT_SOURCE,
  PARTICIPANTS_PATH,
  participantLabelsSql,
  type ParticipantData,
  type Role,
} from "../src/participants.ts";

const { values } = parseArgs({ options: { ref: { type: "string" } } });

async function get(url: string) {
  const res = await fetch(url, { headers: { accept: "application/vnd.github+json" } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.json();
}

const ref =
  values.ref ?? ((await get(`https://api.github.com/repos/${PARTICIPANT_SOURCE}/commits/main`)) as { sha: string }).sha;
const participants = [];
for (const [role, file] of Object.entries(PARTICIPANT_FILES) as [Role, string][])
  participants.push(...normalize(role, await get(`https://raw.githubusercontent.com/${PARTICIPANT_SOURCE}/${ref}/${file}`)));

const data: ParticipantData = { source: PARTICIPANT_SOURCE, ref, participants };
await writeFile(PARTICIPANTS_PATH, `${JSON.stringify(data, null, 2)}\n`);
await writeFile(LABELS_SQL_PATH, participantLabelsSql(data));
console.log(`${participants.length} participants from ${PARTICIPANT_SOURCE}@${ref.slice(0, 7)}`);
