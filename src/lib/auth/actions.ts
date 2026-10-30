"use server";

import { z } from "zod";
import { redirect } from "next/navigation";
import { CAPTCHA_MESSAGES, verifyCaptcha } from "@/lib/captcha/turnstile";
import { getPublicEnvStatus } from "@/lib/env";
import { createClient } from "@/lib/supabase/server";
import { RPC_ERROR_MESSAGES, rpcErrorCode, rpcErrorMessage } from "@/lib/errors";
import { sanitizeNext } from "@/lib/utils/safe-redirect";
import {
  forgotPasswordSchema,
  loginSchema,
  registerRestaurantSchema,
  signupSchema,
  toFieldErrors,
} from "@/lib/validation/auth";
import type { FormState } from "./form-state";
import { allowAuthAction, currentClientIp } from "./rate-limit";
import { requireUser } from "./guards";

const NOT_CONFIGURED: FormState = {
  status: "error",
  message:
    "O Supabase ainda não está configurado neste ambiente. Defina as variáveis de ambiente e reinicie o servidor.",
};

function text(formData: FormData, key: string): string {
  const value = formData.get(key);
  return typeof value === "string" ? value : "";
}

/**
 * Origem usada nos links dos e-mails de autenticação: SEMPRE `NEXT_PUBLIC_SITE_URL` (S-07). Nunca deduzida
 * do cabeçalho Host (forjável). Sem a variável o link usa o `site_url` configurado no Supabase Auth.
 */
async function resolveOrigin(): Promise<string | null> {
  const status = getPublicEnvStatus();
  return status.ok && status.env.siteUrl ? status.env.siteUrl.replace(/[/]$/, "") : null;
}

function loginErrorMessage(code: string | undefined, status: number | undefined) {
  if (code === "invalid_credentials") return "E-mail ou senha incorretos.";
  if (code === "email_not_confirmed") {
    return "Confirme seu e-mail pelo link que enviamos antes de entrar.";
  }
  if (code === "over_request_rate_limit" || status === 429) {
    return "Muitas tentativas. Aguarde alguns instantes e tente de novo.";
  }
  return "Não foi possível entrar agora. Tente novamente em instantes.";
}

export async function loginAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!getPublicEnvStatus().ok) return NOT_CONFIGURED;

  const raw = { email: text(formData, "email"), password: text(formData, "password") };
  const parsed = loginSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      status: "error",
      fieldErrors: toFieldErrors(parsed.error),
      values: { email: raw.email },
    };
  }

  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return {
      status: "error",
      message: loginErrorMessage(error.code, error.status),
      values: { email: raw.email },
    };
  }

  redirect(sanitizeNext(formData.get("next")) ?? "/entrar");
}

export async function signupAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!getPublicEnvStatus().ok) return NOT_CONFIGURED;

  const raw = {
    fullName: text(formData, "fullName"),
    email: text(formData, "email"),
    password: text(formData, "password"),
    confirmPassword: text(formData, "confirmPassword"),
  };
  const values = { fullName: raw.fullName, email: raw.email };
  const parsed = signupSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: toFieldErrors(parsed.error), values };
  }

  const ip = await currentClientIp();
  if (!(await allowAuthAction("signup", ip))) {
    return {
      status: "error",
      message: "Muitas tentativas de cadastro em pouco tempo. Aguarde um pouco e tente de novo.",
      values,
    };
  }
  const captcha = await verifyCaptcha(text(formData, "cf-turnstile-response"), ip);
  if (!captcha.ok) {
    return { status: "error", message: CAPTCHA_MESSAGES[captcha.reason], values };
  }

  const origin = await resolveOrigin();
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email: parsed.data.email,
    password: parsed.data.password,
    options: {
      data: { full_name: parsed.data.fullName },
      emailRedirectTo: origin ? `${origin}/auth/callback?next=/entrar` : undefined,
    },
  });

  if (error) {
    if (error.code === "weak_password") {
      return {
        status: "error",
        fieldErrors: { password: "Senha considerada fraca. Escolha outra mais forte." },
        values,
      };
    }
    if (error.code === "user_already_exists") {
      // S-03: resposta idêntica à de um cadastro novo (sem enumerar contas).
      return {
        status: "success",
        message:
          "Enviamos um link de confirmação para o seu e-mail. Abra a mensagem para ativar a conta e depois entre. Se você já tem conta, use Esqueci minha senha na tela de login.",
      };
    }
    if (error.code === "over_email_send_rate_limit" || error.status === 429) {
      return {
        status: "error",
        message: "Muitas tentativas. Aguarde alguns instantes e tente de novo.",
        values,
      };
    }
    return {
      status: "error",
      message: "Não foi possível criar a conta agora. Tente novamente em instantes.",
      values,
    };
  }

  // Confirmação de e-mail desligada: a sessão já existe.
  if (data.session) redirect("/entrar");

  // Resposta neutra (não revela se o e-mail já estava cadastrado).
  return {
    status: "success",
    message:
      "Enviamos um link de confirmação para o seu e-mail. Abra a mensagem para ativar a conta e depois entre.",
  };
}

const FORGOT_NEUTRAL: FormState = {
  status: "success",
  message:
    "Se existir uma conta com este e-mail, enviamos um link para criar uma nova senha. Confira a caixa de entrada e o spam.",
};

/**
 * Pede o e-mail de recuperação. A resposta é IDÊNTICA exista a conta ou não (sem enumeração) e o
 * `redirectTo` sai de NEXT_PUBLIC_SITE_URL, nunca do Host. O callback troca o código e leva a /redefinir-senha.
 */
export async function forgotPasswordAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!getPublicEnvStatus().ok) return NOT_CONFIGURED;

  const raw = { email: text(formData, "email") };
  const parsed = forgotPasswordSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: toFieldErrors(parsed.error), values: raw };
  }

  const ip = await currentClientIp();
  const email = parsed.data.email.toLowerCase();
  // Os dois limites contam sempre (resposta neutra mesmo quando o limite é atingido para não vazar nada).
  const okIp = await allowAuthAction("forgot-ip", ip);
  const okEmail = await allowAuthAction("forgot-email", email);
  if (!okIp) {
    return { status: "error", message: "Muitas tentativas. Aguarde um pouco e tente de novo.", values: raw };
  }

  const captcha = await verifyCaptcha(text(formData, "cf-turnstile-response"), ip);
  if (!captcha.ok) return { status: "error", message: CAPTCHA_MESSAGES[captcha.reason], values: raw };

  if (okEmail) {
    const origin = await resolveOrigin();
    const supabase = await createClient();
    const { error } = await supabase.auth.resetPasswordForEmail(email, {
      redirectTo: origin ? `${origin}/auth/callback?next=/redefinir-senha` : undefined,
    });
    // Falha do provedor (SMTP, limite) não é revelada: a tela é sempre a mesma.
    if (error) console.error("[auth] resetPasswordForEmail:", error.code ?? error.status ?? "erro");
  }
  return FORGOT_NEUTRAL;
}



export async function logoutAction(): Promise<void> {
  if (getPublicEnvStatus().ok) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/login");
}

export async function registerRestaurantAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!getPublicEnvStatus().ok) return NOT_CONFIGURED;
  // Autorização: somente usuários autenticados (re-verificado no servidor).
  await requireUser("/entrar");

  const raw = { name: text(formData, "name"), slug: text(formData, "slug") };
  const parsed = registerRestaurantSchema.safeParse(raw);
  if (!parsed.success) {
    return { status: "error", fieldErrors: toFieldErrors(parsed.error), values: raw };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("register_restaurant", {
    p_name: parsed.data.name,
    p_slug: parsed.data.slug,
  });

  if (error) {
    const code = rpcErrorCode(error);
    if (code === "slug_unavailable" || code === "invalid_slug") {
      return {
        status: "error",
        fieldErrors: { slug: RPC_ERROR_MESSAGES[code] },
        values: raw,
      };
    }
    if (code === "invalid_name") {
      return {
        status: "error",
        fieldErrors: { name: RPC_ERROR_MESSAGES[code] },
        values: raw,
      };
    }
    return {
      status: "error",
      message: rpcErrorMessage(error),
      values: raw,
    };
  }

  redirect("/entrar?registrado=1");
}

/**
 * Aceita um convite pendente (RPC `accept_invitation(p_membership uuid)`).
 * O banco valida que o convite pertence ao usuário (e-mail confirmado).
 */
export async function acceptInvitationAction(
  _previous: FormState,
  formData: FormData,
): Promise<FormState> {
  if (!getPublicEnvStatus().ok) return NOT_CONFIGURED;
  await requireUser("/entrar");

  const parsed = z.uuid().safeParse(text(formData, "membershipId"));
  if (!parsed.success) {
    return { status: "error", message: RPC_ERROR_MESSAGES.invitation_not_found };
  }

  const supabase = await createClient();
  const { error } = await supabase.rpc("accept_invitation", {
    p_membership: parsed.data,
  });
  if (error) return { status: "error", message: rpcErrorMessage(error) };

  redirect("/entrar?convite=aceito");
}
