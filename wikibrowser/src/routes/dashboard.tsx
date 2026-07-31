import { createFileRoute, Outlet } from "@tanstack/react-router";
import DashboardLayout from "@/app/dashboard/layout";

export const Route = createFileRoute("/dashboard")({ component: () => <DashboardLayout><Outlet /></DashboardLayout> });
