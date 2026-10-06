trigger GSquareArenaBookingTrigger on Opportunity(after insert, after update) {
  // The TV celebration must never block saving an Opportunity.
  try {
    GSquareArenaBookingEvents.publishNewBookings(
      (List<Opportunity>) Trigger.new,
      Trigger.isUpdate ? (Map<Id, Opportunity>) Trigger.oldMap : null
    );
  } catch (Exception e) {
    System.debug(LoggingLevel.ERROR, 'GSquareArenaBookingTrigger: ' + e.getMessage());
  }
}
