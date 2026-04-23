interface Props { category: string; size?: 'sm' | 'xs'; }

export default function CategoryBadge({ category, size = 'sm' }: Props) {
  const cls = size === 'xs'
    ? 'text-[10px] px-1.5 py-0.5'
    : 'text-xs px-2 py-0.5';
  return (
    <span className={`inline-block rounded border font-medium ${cls} cat-${category}`}>
      {category.replace('_', ' ')}
    </span>
  );
}
