import { LegalLandscape } from "@/components/intel/legal/legal-landscape"

/**
 * Legal Landscape — regulatory, legislative and enforcement developments
 * bearing on distressed CRE debt, rebuilt here from the Market Intelligence
 * tool. Each item's stated scope is counted against Florida's FDIC filers.
 */
export default function Legal() {
  return (
    <div className="p-6">
      <LegalLandscape />
    </div>
  )
}
