import { NextResponse } from "next/server";
import clientPromise from "@/lib/mongodb";

export async function GET() {
    const uri = process.env.MONGODB_URI;
    let dbName = "error";
    try {
        const client = await clientPromise;
        dbName = client.db().databaseName;
    } catch (e) { }

    return NextResponse.json({
        actual_mongodb_uri: uri,
        resolved_db_name: dbName
    });
}
