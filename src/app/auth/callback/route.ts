import { NextResponse, type NextRequest } from "next/server";
import type { EmailOtpType } from "@supabase/supabase-js";
import { getPublicEnvStatus } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { safeNextOr } from "@/lib/utils/safe-redirect";

const OTP_TYPES: readonly EmailOtpType[] = [
  "signup",
  "invite",
  "magiclink",
  "recovery",
  "email_change",
  "email",
];

function isOtpType(value: string | null): value is EmailOtpType {
  return OTP_TYPES.some((type) => type === value);
}

/**
 * Callback dos links de e-mail do Supabase (confirmação, convite, recuperação).
 * Troca o código PKCE (ou o token_hash) por uma sessão e redireciona para um
 * caminho INTERNO validado em `next`.
 */
export async function GET(request: NextRequest) {
  const { searchParams, origin } = request.nextUrl;
  const next = safeNextOr(searchParams.get("next"), "/entrar");
  const failure = NextResponse.redirect(new URL("/login?erro=callback", origin));

  if (!getPublicEnvStatus().ok) return failure;

  const code = searchParams.get("code");
  const tokenHash = searchParams.get("token_hash");
  const type = searchParams.get("type");

  const supabase = await createClient();

  if (code) {
    const { error } = await supabase.auth.exchangeCodeForSession(code);
    if (!error) return NextResponse.redirect(new URL(next, origin));
    return failure;
  }

  if (tokenHash && isOtpType(type)) {
    const { error } = await supabase.auth.verifyOtp({ type, token_hash: tokenHash });
    if (!error) return NextResponse.redirect(new URL(next, origin));
  }

  return failure;
}
