/**
 * Shared constants for fingertip-based interactions.
 * Used by both PhysicalInteractionProvider (poke spherecast) and HandRayProvider (raycast locus)
 * to ensure consistent fingertip positioning across interaction systems.
 */

/**
 * Radius (cm) of the spherecast used for poke detection.
 */
export const FINGERTIP_SPHERECAST_RADIUS = 0.7

/**
 * Vertical offset (cm) from the raw index tip position to the center of the fingertip.
 * Negative value shifts DOWN from the top of the fingertip toward its center.
 * This accounts for the fact that hand tracking returns the "top" of the fingertip,
 * but interactions should target the "middle" of the pad.
 */
export const FINGERTIP_UP_OFFSET = -0.36

/**
 * Forward offset (cm) adjustment for the spherecast endpoint.
 * Adjusts the spherecast to better match the physical fingertip surface.
 */
export const FINGERTIP_FORWARD_OFFSET = -0.11

/**
 * Radius (cm) used when MAINTAINING a poke (bistability).
 * Slightly larger than entry radius to prevent oscillation from hand tracking noise.
 */
export const FINGERTIP_MAINTAIN_RADIUS = 0.9

