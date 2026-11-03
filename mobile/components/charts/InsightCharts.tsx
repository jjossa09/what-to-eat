import BarChart, { type ChartProps } from './BarChart';
import CompanyShareRing from './CompanyShareRing';
import PriceDistributionChart from './PriceDistributionChart';
import DistanceTimelineChart from './DistanceTimelineChart';
import type { InsightSlot } from '../../lib/api';

export function TopCategoriesChart(props: ChartProps) {
  return <BarChart title="Top categories" chartId="top" {...props} />;
}

export function FoodBySlotChart(props: ChartProps) {
  return <BarChart title="Food by meal slot" chartId="food" {...props} />;
}

export function PriceBySlotChart(props: ChartProps) {
  return <PriceDistributionChart {...props} />;
}

export function MealDistanceChart(props: ChartProps & {
  selectedSlot: InsightSlot; onSlotChange: (slot: InsightSlot) => void;
}) {
  return <DistanceTimelineChart {...props} />;
}

export function CompanionMealsChart(props: ChartProps) {
  return <BarChart title="Meals by companion" chartId="companions" {...props}
    maximum={props.data.ring?.total}
    beforeBars={props.data.ring && <CompanyShareRing data={props.data.ring} />} />;
}
