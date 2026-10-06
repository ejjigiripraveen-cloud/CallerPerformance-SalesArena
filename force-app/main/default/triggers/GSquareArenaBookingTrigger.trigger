trigger GSquareArenaBookingTrigger on Opportunity(after insert, after update) {
  // The TV celebration must never block saving an Opportunity.
  try {
    GSquareArenaBookingEvents.publishNewBookings(
      Trigger.new,
      Trigger.isUpdate ? Trigger.oldMap : null
    );
  } catch (Exception e) {
    System.debug(
      LoggingLevel.ERROR,
      'GSquareArenaBookingTrigger: ' + e.getMessage()
    );
  }
}
