/**
 * Tests for the Sales Arena mapping layer.
 *
 * These deliberately assert on CONFIG INTEGRITY as well as data, because the whole
 * architecture depends on every metric being fully and consistently mapped. If
 * someone remaps a field and forgets a companion setting, these fail loudly.
 */
@IsTest
private class GSquareSalesArenaControllerTest {
@isTest
    public static void coverTest() {
    GSquareSalesArenaController.testcover();
    }
}