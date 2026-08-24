import { redirect } from "next/navigation";
import { createClient } from "@/lib/supabase/server";

export async function getClaims() {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  return {
    supabase,
    claims: error ? null : data?.claims,
    error,
  };
}

export async function requireClaims() {
  const { supabase, claims, error } = await getClaims();

  if (error || !claims?.sub) {
    redirect("/");
  }

  return { supabase, claims };
}
