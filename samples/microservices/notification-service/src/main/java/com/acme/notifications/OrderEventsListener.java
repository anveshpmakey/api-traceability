package com.acme.notifications;

import org.springframework.kafka.annotation.KafkaListener;
import org.springframework.stereotype.Component;

@Component
public class OrderEventsListener {
    private final NotificationService notificationService;

    public OrderEventsListener(NotificationService notificationService) {
        this.notificationService = notificationService;
    }

    @KafkaListener(topics = "${app.topics.orders}", groupId = "notifications")
    public void onOrderEvent(String payload) {
        notificationService.notifyCustomer(payload);
    }
}
