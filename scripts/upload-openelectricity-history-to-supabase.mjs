import { readFile } from "node:fs/promises";
import path from "node:path";
import nextEnv from "@next/env";
import {
  createAdminClient,
  OPEN_ELECTRICITY_DATA_TABLE,
} from "../lib/supabase/admin.js";

const { loadEnvConfig } = nextEnv;

loadEnvConfig(process.cwd());

const inputPath = process.argv[2]
  ? path.resolve(process.cwd(), process.argv[2])
  : path.join(process.cwd(), "openelectricity-history.json");

const rawContent = await readFile(inputPath, "utf8");
const snapshot = JSON.parse(rawContent);
const supabase = createAdminClient();

const { count, error: countError } = await supabase
  .from(OPEN_ELECTRICITY_DATA_TABLE)
  .select("data", { count: "exact", head: true });

if (countError) {
  throw new Error(
    `Unable to inspect Supabase table ${OPEN_ELECTRICITY_DATA_TABLE}: ${countError.message}`,
  );
}

if ((count ?? 0) === 0) {
  const { error: insertError } = await supabase
    .from(OPEN_ELECTRICITY_DATA_TABLE)
    .insert({ data: snapshot });

  if (insertError) {
    throw new Error(`Unable to insert snapshot into Supabase: ${insertError.message}`);
  }

  console.log(
    `Inserted Open Electricity snapshot from ${inputPath} into ${OPEN_ELECTRICITY_DATA_TABLE}.`,
  );
} else {
  const { error: updateError } = await supabase
    .from(OPEN_ELECTRICITY_DATA_TABLE)
    .update({ data: snapshot })
    .or("data.is.null,data.not.is.null");

  if (updateError) {
    throw new Error(`Unable to overwrite snapshot in Supabase: ${updateError.message}`);
  }

  console.log(
    `Overwrote existing Open Electricity snapshot in ${OPEN_ELECTRICITY_DATA_TABLE} using ${inputPath}.`,
  );
}
