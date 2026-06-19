"use client";

import {
    Dialog,
    DialogContent,
    DialogHeader,
    DialogTitle,
    DialogDescription,
} from "@/components/ui/dialog";
import { LoginForm } from "@/components/login-form";

interface LoginModalProps {
    open: boolean;
    onOpenChange: (open: boolean) => void;
}

export function LoginModal({ open, onOpenChange }: LoginModalProps) {
    return (
        <Dialog open={open} onOpenChange={onOpenChange}>
            <DialogContent className="sm:max-w-md">
                <DialogHeader>
                    <DialogTitle className="text-center">Sign In</DialogTitle>
                    <DialogDescription className="sr-only">
                        Sign in to sync your settings and library across devices.
                    </DialogDescription>
                </DialogHeader>
                <LoginForm />
            </DialogContent>
        </Dialog>
    );
}
