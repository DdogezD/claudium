// Stubbed: all Anthropic admin request API communication removed.

export type AdminRequestType = 'limit_increase' | 'seat_upgrade'

export type AdminRequestStatus = 'pending' | 'approved' | 'dismissed'

export type AdminRequestSeatUpgradeDetails = {
  message?: string | null
  current_seat_tier?: string | null
}

export type AdminRequestCreateParams =
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }

export type AdminRequest = {
  uuid: string
  status: AdminRequestStatus
  requester_uuid?: string | null
  created_at: string
} & (
  | {
      request_type: 'limit_increase'
      details: null
    }
  | {
      request_type: 'seat_upgrade'
      details: AdminRequestSeatUpgradeDetails
    }
)

export async function createAdminRequest(
  ...args: any[]
): Promise<AdminRequest | null> {
  return null
}

export async function getMyAdminRequests(
  ...args: any[]
): Promise<AdminRequest[] | null> {
  return null
}

export async function checkAdminRequestEligibility(
  ...args: any[]
): Promise<{ request_type: AdminRequestType; is_allowed: boolean } | null> {
  return null
}
