import { NextRequest, NextResponse } from 'next/server';
import { searchFilamentCatalog } from '@/lib/bambu/filament-catalog';

export async function GET(request: NextRequest) {
  try {
    const q = request.nextUrl.searchParams.get('q') ?? undefined;
    const entries = searchFilamentCatalog(q);
    return NextResponse.json({ entries, count: entries.length });
  } catch (error) {
    console.error('Error loading Bambu filament catalog:', error);
    return NextResponse.json({ error: 'Failed to load filament catalog' }, { status: 500 });
  }
}
