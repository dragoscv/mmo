"use client";

import { useState } from "react";
import { LogIn } from "lucide-react";
import { Button } from "@/components/ui/button";
import { LoginModal } from "@/components/login-modal";

interface SignInButtonProps {
    label?: string;
    className?: string;
}

/**
 * Opens the authentication modal (shared <LoginForm>) instead of navigating
 * to /login. Used by empty-state CTAs so signing in keeps the user in place.
 */
export function SignInButton({ label = "Sign in", className }: SignInButtonProps) {
    const [open, setOpen] = useState(false);
    return (
        <>
            <Button className={className} onClick={() => setOpen(true)}>
                <LogIn className="mr-2 h-4 w-4" /> {label}
            </Button>
            <LoginModal open={open} onOpenChange={setOpen} />
        </>
    );
}
