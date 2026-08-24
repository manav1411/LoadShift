"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { createClient } from "@/lib/supabase/client";

export default function AuthPanel() {
  const router = useRouter();
  const supabase = createClient();
  const [mode, setMode] = useState(null);
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  function openForm(nextMode) {
    setMode(nextMode);
    setMessage("");
    setError("");
  }

  function closeForm() {
    setMode(null);
    setMessage("");
    setError("");
  }

  async function handleSubmit(event) {
    event.preventDefault();
    setIsSubmitting(true);
    setMessage("");
    setError("");

    const result = mode === "signup"
      ? await supabase.auth.signUp({
          email,
          password,
          options: {
            data: { display_name: fullName, full_name: fullName },
            emailRedirectTo: `${window.location.origin}/auth/callback`,
          },
        })
      : await supabase.auth.signInWithPassword({ email, password });

    if (result.error) {
      setError(result.error.message);
      setIsSubmitting(false);
      return;
    }

    if (mode === "signup" && !result.data.session) {
      setMessage("Check your email to confirm your account, then sign in.");
      setIsSubmitting(false);
      return;
    }

    router.push("/dashboard");
    router.refresh();
  }

  if (!mode) {
    return (
      <div className="auth-actions">
        <button className="auth-button" type="button" onClick={() => openForm("signin")}>Sign in</button>
        <button className="auth-button" type="button" onClick={() => openForm("signup")}>Sign up</button>
      </div>
    );
  }

  return (
    <div className="auth-box">
      <div className="auth-box-header">
        <h2>{mode === "signup" ? "Sign up" : "Sign in"}</h2>
        <button className="back-button" type="button" onClick={closeForm}>Back</button>
      </div>
      <form onSubmit={handleSubmit}>
        {mode === "signup" && (
          <label>
            Name
            <input value={fullName} onChange={(event) => setFullName(event.target.value)} type="text" autoComplete="name" required />
          </label>
        )}
        <label>
          Email
          <input value={email} onChange={(event) => setEmail(event.target.value)} type="email" autoComplete="email" required />
        </label>
        <label>
          Password
          <input value={password} onChange={(event) => setPassword(event.target.value)} type="password" minLength={6} autoComplete={mode === "signup" ? "new-password" : "current-password"} required />
        </label>
        <button className="submit-button" type="submit" disabled={isSubmitting}>
          {isSubmitting ? "Please wait…" : mode === "signup" ? "Create account" : "Sign in"}
        </button>
      </form>
      {message && <p className="form-message" role="status">{message}</p>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>
  );
}
