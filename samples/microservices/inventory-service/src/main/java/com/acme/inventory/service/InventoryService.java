package com.acme.inventory.service;

import com.acme.inventory.repo.ReservationRepository;
import com.acme.inventory.repo.StockItem;
import com.acme.inventory.repo.StockRepository;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

@Service
public class InventoryService {

    @Autowired
    private StockRepository stockRepository;

    @Autowired
    private ReservationRepository reservationRepository;

    public int available(String sku) {
        return stockRepository.findBySku(sku).map(StockItem::getQuantity).orElse(0);
    }

    public void reserve(String sku, int qty) {
        StockItem item = stockRepository.findBySku(sku).orElseThrow();
        stockRepository.save(item);
        reservationRepository.save(new Object());
    }

    public void release(Long orderId) {
        reservationRepository.deleteByOrderId(orderId);
    }
}
