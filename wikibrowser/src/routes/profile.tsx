import { createFileRoute } from "@tanstack/react-router";
import ProfileLayout from "@/app/profile/layout";
import ProfilePage from "@/app/profile/page";
import { routeHead } from "@/lib/route-head";

export const Route = createFileRoute("/profile")({ head: () => routeHead("Kinic Wiki My Profile", "View your ledger KINIC balance for Kinic Wiki."), component: () => <ProfileLayout><ProfilePage /></ProfileLayout> });
