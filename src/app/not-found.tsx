import Link from "next/link";

export default function NotFound() {
  return (
    <div className="max-w-xl mx-auto mt-10 text-center text-sm text-gray-700">
      <div className="text-lg font-semibold text-navy">페이지를 찾을 수 없습니다.</div>
      <Link href="/" className="text-navy underline mt-2 inline-block">
        종합 대시보드로
      </Link>
    </div>
  );
}
