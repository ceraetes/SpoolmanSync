'use client';

import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';

interface SummaryCardsProps {
  totalWeight: number;
  totalPrints: number;
  uniqueSpools: number;
}

export function SummaryCards({ totalWeight, totalPrints, uniqueSpools }: SummaryCardsProps) {
  const avgPerPrint = totalPrints > 0 ? totalWeight / totalPrints : 0;

  return (
    <div className="grid gap-4 grid-cols-2 sm:grid-cols-4">
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Total Used</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalWeight.toFixed(1)}g</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Usage Events</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{totalPrints}</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Avg per Event</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{avgPerPrint.toFixed(1)}g</div>
        </CardContent>
      </Card>
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">Spools Used</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="text-2xl font-bold">{uniqueSpools}</div>
        </CardContent>
      </Card>
    </div>
  );
}
