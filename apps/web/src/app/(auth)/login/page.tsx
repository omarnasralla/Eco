'use client';

import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { Loader2 } from 'lucide-react';
import { loginSchema, type LoginInput } from '@eco/shared';
import { useAuth } from '@/lib/auth-provider';
import { ApiError } from '@/lib/api-client';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';

export default function LoginPage() {
  const router = useRouter();
  const { login, completeTwoFactor } = useAuth();
  const [formError, setFormError] = useState<string | null>(null);
  // Set when the account has 2FA on; the form then swaps to a code field
  // rather than navigating, so the password step is not repeated.
  const [challengeToken, setChallengeToken] = useState<string | null>(null);
  const [totpCode, setTotpCode] = useState('');
  const [verifying, setVerifying] = useState(false);

  const {
    register,
    handleSubmit,
    formState: { errors, isSubmitting },
  } = useForm<LoginInput>({
    // The very same schema the API validates against — one definition, so a
    // rule can never drift between client and server.
    resolver: zodResolver(loginSchema),
    defaultValues: { email: '', password: '' },
  });

  const onSubmit = handleSubmit(async (values) => {
    setFormError(null);
    try {
      const result = await login(values);
      if (result.twoFactorRequired && result.challengeToken) {
        setChallengeToken(result.challengeToken);
        return;
      }
      router.replace('/dashboard');
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'Something went wrong. Please try again.',
      );
    }
  });

  const onVerify = async (event: React.FormEvent) => {
    event.preventDefault();
    if (!challengeToken) return;
    setFormError(null);
    setVerifying(true);
    try {
      await completeTwoFactor(challengeToken, totpCode);
      router.replace('/dashboard');
    } catch (error) {
      setFormError(
        error instanceof ApiError ? error.message : 'That code was not accepted.',
      );
    } finally {
      setVerifying(false);
    }
  };

  if (challengeToken) {
    return (
      <Card>
        <CardHeader>
          <CardTitle>Enter your code</CardTitle>
          <CardDescription>
            Open your authenticator app and enter the six-digit code for Eco.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={onVerify} className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="totp">Verification code</Label>
              <Input
                id="totp"
                // `one-time-code` lets iOS and Android autofill the code from
                // the notification, which is the difference between one tap and
                // switching apps.
                autoComplete="one-time-code"
                inputMode="numeric"
                pattern="[0-9]*"
                maxLength={6}
                autoFocus
                value={totpCode}
                onChange={(event) => setTotpCode(event.target.value.replace(/\D/g, ''))}
                className="text-center text-lg tracking-[0.4em]"
              />
            </div>
            {formError ? (
              <p role="alert" className="text-sm text-destructive">
                {formError}
              </p>
            ) : null}
            <Button type="submit" className="w-full" disabled={verifying || totpCode.length !== 6}>
              {verifying ? <Loader2 className="animate-spin" aria-hidden /> : null}
              Verify
            </Button>
            <Button
              type="button"
              variant="ghost"
              className="w-full"
              onClick={() => {
                setChallengeToken(null);
                setTotpCode('');
                setFormError(null);
              }}
            >
              Back
            </Button>
          </form>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Welcome back</CardTitle>
        <CardDescription>Sign in to pick up where you left off.</CardDescription>
      </CardHeader>
      <CardContent>
        <form onSubmit={onSubmit} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              inputMode="email"
              autoCapitalize="none"
              spellCheck={false}
              aria-invalid={Boolean(errors.email)}
              {...register('email')}
            />
            {errors.email ? (
              <p className="text-sm text-destructive">{errors.email.message}</p>
            ) : null}
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label htmlFor="password">Password</Label>
              <Link
                href="/forgot-password"
                className="text-xs text-muted-foreground underline-offset-4 hover:underline"
              >
                Forgot password?
              </Link>
            </div>
            <Input
              id="password"
              type="password"
              autoComplete="current-password"
              aria-invalid={Boolean(errors.password)}
              {...register('password')}
            />
            {errors.password ? (
              <p className="text-sm text-destructive">{errors.password.message}</p>
            ) : null}
          </div>

          {formError ? (
            <p role="alert" className="text-sm text-destructive">
              {formError}
            </p>
          ) : null}

          <Button type="submit" className="w-full" disabled={isSubmitting}>
            {isSubmitting ? <Loader2 className="animate-spin" aria-hidden /> : null}
            Sign in
          </Button>
        </form>

        <p className="mt-6 text-center text-sm text-muted-foreground">
          New to Eco?{' '}
          <Link href="/register" className="font-medium text-primary underline-offset-4 hover:underline">
            Create an account
          </Link>
        </p>
      </CardContent>
    </Card>
  );
}
