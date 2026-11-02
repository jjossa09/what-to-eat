import BarChart, { type ChartProps } from './BarChart';

export function TopCategoriesChart(props: ChartProps) {
  return <BarChart title="Top categories" {...props} />;
}

export function FoodBySlotChart(props: ChartProps) {
  return <BarChart title="Food by meal slot" {...props} />;
}

export function PriceBySlotChart(props: ChartProps) {
  return <BarChart title="Price by meal slot" {...props} />;
}

export function MealDistanceChart(props: ChartProps) {
  return <BarChart title="Meal distance" {...props} />;
}

export function CompanionMealsChart(props: ChartProps) {
  return <BarChart title="Meals by companion" {...props} />;
}
