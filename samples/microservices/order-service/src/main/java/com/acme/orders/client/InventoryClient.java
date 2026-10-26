package com.acme.orders.client;

import org.springframework.cloud.openfeign.FeignClient;
import org.springframework.web.bind.annotation.*;

@FeignClient(name = "inventory-service", path = "/api/inventory")
public interface InventoryClient {

    @PostMapping("/{sku}/reserve")
    void reserve(@PathVariable("sku") String sku, @RequestParam("qty") int quantity);

    @DeleteMapping("/reservations/{orderId}")
    void release(@PathVariable("orderId") Long orderId);
}
