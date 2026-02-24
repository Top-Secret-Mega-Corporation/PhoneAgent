"use client";

import { authClient } from "@/lib/auth-client";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";


export default function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  // Redirect if already logged in
  useEffect(() => {
    if (session) {
      router.push("/");
    }
  }, [session, router]); // run only when session or router changes


  async function handleSubmit(e: any) {
    e.preventDefault();

    const { error } = await authClient.signIn.email({
      email,
      password,
    });

    if (error) {
      alert(error.message);
    } else {
      router.push("/");
    }
  }

  return (
   <div className="min-h-screen flex items-center justify-center bg-neutral-950 text-neutral-100">
  <form 
    onSubmit={handleSubmit} 
    className="bg-white p-8 rounded-lg shadow-md w-full max-w-sm"
  >
    <h2 className="text-2xl font-semibold mb-6 text-center text-gray-800">Login</h2>

    <input
      type="email"
      placeholder="Email"
      onChange={(e) => setEmail(e.target.value)}
      className="w-full p-3 mb-4 rounded border border-gray-300 focus:outline-none focus:ring-2 text-black focus:ring-blue-500 placeholder:text-black"
    />

    <input
      type="password"
      placeholder="Password"
      onChange={(e) => setPassword(e.target.value)}
      className="w-full p-3 mb-6 rounded border border-gray-300 focus:outline-none focus:ring-2 text-black focus:ring-blue-500 placeholder:text-black"
    />

    <button
      type="submit"
      className="w-full bg-blue-500 text-white py-3 rounded hover:bg-blue-600 transition-colors font-semibold"
    >
      Login
    </button>
     <p className="text-center text-gray-600 mt-4">
     <Link href="/auth/register" className="text-blue-500 hover:underline">
            Don't have a account? Register Here
    </Link>
    </p>
  </form>
</div>
  );
}