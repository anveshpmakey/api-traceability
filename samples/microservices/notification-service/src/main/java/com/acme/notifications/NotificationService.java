package com.acme.notifications;

import org.springframework.stereotype.Service;
import org.springframework.web.client.RestClient;

@Service
public class NotificationService {
    private final RestClient restClient = RestClient.create("http://customer-service");

    public void notifyCustomer(String payload) {
        restClient.get().uri("/api/customers/{id}/verification", payload).retrieve().body(Boolean.class);
    }
}
