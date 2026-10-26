package com.acme.orders.client;

import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Component;
import org.springframework.web.reactive.function.client.WebClient;

@Component
public class CustomerClient {

    private final WebClient webClient;

    public CustomerClient(WebClient.Builder builder, @Value("${clients.customer.base-url}") String baseUrl) {
        this.webClient = builder.baseUrl(baseUrl).build();
    }

    public void verify(String customerId) {
        webClient.get().uri("/{id}/verification", customerId).retrieve().toBodilessEntity().block();
    }
}
